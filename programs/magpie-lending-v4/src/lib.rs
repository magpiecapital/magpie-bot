use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
// Token-2022 support for collateral side. wSOL (loan token) stays on legacy Token.
use anchor_spl::token_interface::{
    self,
    Mint as MintIfc,
    TokenAccount as TokenAccountIfc,
    TokenInterface,
    TransferChecked,
};

// v4 — adds in-vault auto-sell conversion. The Loan account now tracks
// two new pieces of state: current_collateral_amount (SPL tokens still in
// vault, decreases as auto-sells fire) and sol_proceeds_amount (SOL that
// accumulated from those sells, sits in the vault until the loan closes).
// A new convert_collateral_slice instruction lets a designated engine
// authority swap a slice via Jupiter CPI and deposit the SOL back into
// the vault — the loan stays ACTIVE, principal owed is unchanged, due
// date unchanged. repay_loan + liquidate_loan now return a mix.
//
// v1 / v2 / v3 continue to serve their existing loans untouched. v4 is a
// PARALLEL deploy. Off-chain bot routes NEW borrows to v4 via env flag;
// existing loans on legacy programs wind down through their normal
// repay/liquidation lifecycle.
//
// Keypair: NEW dedicated v4 deployer keypair. Engine authority is also a
// NEW dedicated keypair, separate from pool authority and lender — least
// privilege so a compromised engine key can ONLY trigger conversions on
// existing loans, never mint new loans or move pool reserves.
//
// PLACEHOLDER program id below — will be replaced with the actual v4
// deploy pubkey by `anchor keys sync` before mainnet deploy.
declare_id!("MAGPie4LendingV4ProgramIDp1aceho1der11111111");

/// Basis-point helpers
const BPS_DENOM: u64 = 10_000;

// ---------------------------------------------------------------------------
// Tier ladders — THESE CONSTANTS ARE THE CONTRACT.
//
// 2026-06-13 LESSON (paid for in user trust): the prior `rwa_loan_tiers`
// DB display table advertised 50/60/70% RWA LTVs while the on-chain v2
// program computed 30/25/20%. Users signed expecting one amount and got
// another. The cure is to make THIS file the single, authoritative source
// of tier params, and have every off-chain surface (DB, dashboard, bot,
// Pip, marketplace) DERIVE from on-chain rather than store its own copy.
//
// v3 ships dual tiers — memecoin and RWA — selected at borrow time via
// the `category` instruction param. The off-chain `rwa_loan_tiers` table
// in the bot's DB is now a downstream mirror that the migration runner
// updates from on-chain at startup, never the other way around.
// ---------------------------------------------------------------------------

const CATEGORY_MEMECOIN: u8 = 0;
const CATEGORY_RWA: u8 = 1;

// Engine authority — the ONLY pubkey allowed to call convert_collateral_slice.
// Placeholder; replaced at build time with the actual dedicated v4 engine
// keypair. NEVER reuse v1/v2/v3 pool authority or lender authority here —
// the engine key is online (signs every limit-close fire) and must have
// least privilege: it can ONLY trigger conversions on EXISTING loans, never
// mint, never withdraw from the pool, never touch the fee wallet.
const ENGINE_AUTHORITY: Pubkey = solana_program::pubkey!("MAGPie4EngineAuthV4P1acehoLderpubkey11111111");

// Protocol fee in basis points (bps) on auto-sell proceeds. 1% — matches
// v1/v2/v3 limit-close fee accrued through limit-close-fee-accrual-watcher.
const PROTOCOL_FEE_BPS_AUTOSELL: u64 = 100;

// Hard cap on slice_bps per call. 10000 = 100%. Sum across multiple calls
// is checked against original_collateral_amount on each invocation.
const SLICE_BPS_MAX: u16 = 10_000;

/// Memecoin tier ladder. Conservative LTVs because volatility on these
/// names can be 30%+ in an hour; short terms keep duration risk in check.
/// Option 0 Express : 30% LTV ·  2 days · 3.0% fee
/// Option 1 Quick   : 25% LTV ·  3 days · 2.0% fee
/// Option 2 Standard: 20% LTV ·  7 days · 1.5% fee
const TIER_MEMECOIN_LTV_BPS: [u64; 3] = [3_000, 2_500, 2_000];
const TIER_MEMECOIN_DURATION_DAYS: [i64; 3] = [2, 3, 7];
const TIER_MEMECOIN_FEE_BPS: [u64; 3] = [300, 200, 150];

/// RWA tier ladder for tokenized stocks / ETFs / metals (Backed
/// xStocks etc.). Intraday vol is typically 1–3% and the holder
/// profile is closer to traditional investors than memecoin traders.
/// The protocol can safely offer higher LTV / longer terms / higher
/// fee. Aspirational design from migration 040 — v3 is where the
/// numbers actually land in the on-chain program.
/// Option 0 RWA Express : 50% LTV ·  7 days · 2.5% fee
/// Option 1 RWA Quick   : 60% LTV · 15 days · 3.5% fee
/// Option 2 RWA Standard: 70% LTV · 30 days · 5.0% fee
const TIER_RWA_LTV_BPS: [u64; 3] = [5_000, 6_000, 7_000];
const TIER_RWA_DURATION_DAYS: [i64; 3] = [7, 15, 30];
const TIER_RWA_FEE_BPS: [u64; 3] = [250, 350, 500];

/// Resolve tier params from (category, option). Returns
/// (ltv_bps, fee_bps, duration_days) so the caller can use them
/// directly. Returns None when category or option is out of range —
/// caller must surface ErrorCode::InvalidCategory or InvalidLoanOption.
fn resolve_tier(category: u8, option: u8) -> Option<(u64, u64, i64)> {
    let i = option as usize;
    if i >= 3 { return None; }
    match category {
        CATEGORY_MEMECOIN => Some((
            TIER_MEMECOIN_LTV_BPS[i],
            TIER_MEMECOIN_FEE_BPS[i],
            TIER_MEMECOIN_DURATION_DAYS[i],
        )),
        CATEGORY_RWA => Some((
            TIER_RWA_LTV_BPS[i],
            TIER_RWA_FEE_BPS[i],
            TIER_RWA_DURATION_DAYS[i],
        )),
        _ => None,
    }
}

/// Reverse-lookup used by extend_loan / partial_repay / off-chain
/// indexers to recover (ltv_bps, fee_bps, duration_days) from a loan's
/// stored (category, ltv_bps). The ltv_bps within a category is
/// uniquely associated with one option index, so this is well-defined.
fn resolve_tier_for_loan(category: u8, ltv_bps: u16) -> Option<(u64, u64, i64)> {
    let table: &[u64; 3] = match category {
        CATEGORY_MEMECOIN => &TIER_MEMECOIN_LTV_BPS,
        CATEGORY_RWA      => &TIER_RWA_LTV_BPS,
        _ => return None,
    };
    let option = table.iter().position(|&v| v == ltv_bps as u64)? as u8;
    resolve_tier(category, option)
}

const SECONDS_PER_DAY: i64 = 86_400;

/// Maximum age (seconds) of the LATEST price sample before borrow is refused.
/// The TWAP itself can include older samples — this is about freshness.
const MAX_PRICE_STALENESS: i64 = 120; // 2 minutes

/// Maximum tolerance (bps) that submitted collateral_value can exceed
/// TWAP-derived value. 300 = 3%.
const MAX_VALUE_TOLERANCE_BPS: u64 = 300;

// --------------------------------------------------------------------------
// TWAP parameters
// --------------------------------------------------------------------------

/// Number of samples in the rolling ring buffer per mint.
/// 32 samples × 30s cadence = ~16 min of history.
/// 32 samples × 60s cadence = ~32 min of history.
const PRICE_HISTORY_CAPACITY: usize = 32;

/// Minimum samples in the buffer before TWAP-validated borrows are allowed.
/// Cold-start: a newly-initialized feed accepts attestations but refuses to
/// validate borrows until enough history accumulates. Critical defense —
/// without this, the first attestation post-init can be a pump.
const MIN_SAMPLES_FOR_TWAP: u8 = 8;

/// Minimum seconds of history covered before TWAP-validated borrows
/// are allowed. Pump-and-borrow attacks unfold in minutes; requiring
/// >= 5 min of history means an attacker can't pump the pool and borrow
/// in the same block.
const MIN_HISTORY_SECONDS: i64 = 300;

/// Spot price (latest sample) cannot exceed TWAP by this much. If it does,
/// the feed reflects an in-progress pump and we refuse to lend until the
/// spike fades. 1_500 bps = 15%.
const MAX_SPOT_VS_TWAP_PUMP_BPS: u64 = 1_500;

/// TWAP window in seconds. Only samples within this window are included
/// in the average. Older samples are ignored (but kept in the ring until
/// overwritten so we don't lose buffer slots).
const TWAP_WINDOW_SECONDS: i64 = 30 * 60; // 30 min

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod magpie_lending {
    use super::*;

    // -----------------------------------------------------------------------
    // Pool management
    // -----------------------------------------------------------------------

    /// Create a permissionless lending pool.  Anyone can call this once per
    /// authority key, but the `protocol_fee_bps` determines how much of each
    /// loan fee goes to the protocol vs the pool depositors.
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        protocol_fee_bps: u16,
        keeper_reward_bps: u16,
    ) -> Result<()> {
        require!(protocol_fee_bps <= 5_000, ErrorCode::FeeTooHigh); // max 50%
        require!(keeper_reward_bps <= 2_000, ErrorCode::KeeperRewardTooHigh); // max 20%

        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.loan_token_vault = ctx.accounts.loan_token_vault.key();
        pool.loan_token_mint = ctx.accounts.loan_token_mint.key();
        pool.protocol_fee_bps = protocol_fee_bps;
        pool.keeper_reward_bps = keeper_reward_bps;
        pool.total_deposits = 0;
        pool.total_shares = 0;
        pool.total_borrowed = 0;
        pool.total_fees_earned = 0;
        pool.total_loans_issued = 0;
        pool.total_liquidations = 0;
        pool.paused = false;
        pool.bump = ctx.bumps.pool;
        pool.vault_bump = ctx.bumps.loan_token_vault;

        emit!(PoolInitialized {
            pool: pool.key(),
            authority: pool.authority,
            protocol_fee_bps,
        });
        Ok(())
    }

    /// Pause / unpause new borrows (authority only).
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.pool.paused = paused;
        Ok(())
    }

    /// Update keeper reward percentage (authority only).
    pub fn set_keeper_reward(ctx: Context<AdminOnly>, keeper_reward_bps: u16) -> Result<()> {
        require!(keeper_reward_bps <= 2_000, ErrorCode::KeeperRewardTooHigh);
        ctx.accounts.pool.keeper_reward_bps = keeper_reward_bps;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Price attestation
    // -----------------------------------------------------------------------

    /// Initialize a price feed for a specific token mint.
    /// Only the pool authority can create feeds for their pool.
    /// v3: the PriceHistory ring buffer starts empty. Borrows are
    /// refused until MIN_SAMPLES_FOR_TWAP samples accumulate AND
    /// MIN_HISTORY_SECONDS of time has elapsed since the first sample.
    pub fn initialize_price_feed(ctx: Context<InitializePriceFeed>) -> Result<()> {
        let feed = &mut ctx.accounts.price_feed;
        feed.mint = ctx.accounts.mint.key();
        feed.pool = ctx.accounts.pool.key();
        feed.authority = ctx.accounts.authority.key();
        feed.head_index = 0;
        feed.count = 0;
        feed._padding = [0u8; 6];
        // Zero-init the ring; samples are read only when count > 0 so
        // the zero values are never consulted, but explicit init keeps
        // the account state deterministic.
        feed.samples = [PriceSample { price_lamports: 0, timestamp: 0 }; PRICE_HISTORY_CAPACITY];
        feed.bump = ctx.bumps.price_feed;

        emit!(PriceFeedInitialized {
            mint: feed.mint,
            pool: feed.pool,
            authority: feed.authority,
        });
        Ok(())
    }

    /// Append a new price sample to the rolling history. Only the pool
    /// authority can call this. The bot calls this on its attestor tick
    /// (every 30-60s). Each call advances the ring buffer one slot.
    ///
    /// `confidence_bps` is accepted for IDL compatibility with v1/v2
    /// but not stored — TWAP makes per-sample confidence less useful.
    pub fn update_price(
        ctx: Context<UpdatePrice>,
        price_lamports: u64,
        _confidence_bps: u16,
    ) -> Result<()> {
        require!(price_lamports > 0, ErrorCode::InvalidCollateralValue);

        let feed = &mut ctx.accounts.price_feed;
        let now = Clock::get()?.unix_timestamp;

        // Defensive guard: refuse a sample that's BEHIND the most recent
        // (clock skew or replay). Time must move forward.
        if let Some(latest) = feed.latest() {
            require!(now >= latest.timestamp, ErrorCode::PriceTimestampWentBackwards);
        }

        feed.append(PriceSample {
            price_lamports,
            timestamp: now,
        });

        emit!(PriceUpdated {
            mint: feed.mint,
            price_lamports,
            confidence_bps: 0,
            timestamp: now,
        });
        Ok(())
    }

    /// Emergency admin withdrawal — transfer wSOL directly from vault to authority.
    /// Only callable by the pool authority. Use this to recover funds that were
    /// deposited outside the share-based deposit flow.
    /// Emergency admin withdrawal — transfer wSOL directly from vault to
    /// authority, BYPASSING share accounting. Intended use: recover funds
    /// that were sent directly to the vault outside the share-based deposit
    /// flow (misroutes, fee dust, etc.). The on-chain enforcement below
    /// guarantees the admin can NEVER drain share-backed deposits, so LP
    /// accounting can never silently break — a class of bug that bit V1/V2
    /// (admin_withdraw had no on-chain excess-only guard, so a careless
    /// --all drain would leave pool.total_deposits over-stated and lock
    /// LPs out of subsequent withdraws).
    pub fn admin_withdraw(ctx: Context<AdminWithdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);

        let pool = &ctx.accounts.pool;
        let vault_balance = ctx.accounts.loan_token_vault.amount;
        // Reserve total_deposits worth of tokens for share-backed LPs — only
        // the EXCESS over that is admin-withdrawable. If misrouted dust has
        // been sent directly, vault_balance > total_deposits and excess is
        // positive; otherwise excess is 0 and admin_withdraw refuses.
        let excess = vault_balance
            .checked_sub(pool.total_deposits)
            .ok_or(ErrorCode::AdminWithdrawWouldDrainLpFunds)?;
        require!(amount <= excess, ErrorCode::AdminWithdrawWouldDrainLpFunds);

        let authority_key = pool.authority.key();
        let seeds = &[
            b"pool".as_ref(),
            authority_key.as_ref(),
            &[pool.bump],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.loan_token_vault.to_account_info(),
                    to: ctx.accounts.authority_token_account.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Depositor operations
    // -----------------------------------------------------------------------

    /// Deposit SOL-equivalent loan tokens into the pool and receive shares.
    /// Shares = deposit_amount * total_shares / pool_value   (or 1:1 if first)
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);

        let pool = &ctx.accounts.pool;
        let pool_value = pool.total_deposits;

        // Calculate shares to mint (use u128 to avoid overflow)
        let shares = if pool.total_shares == 0 || pool_value == 0 {
            amount // 1:1 on first deposit
        } else {
            let shares_u128 = (amount as u128)
                .checked_mul(pool.total_shares as u128)
                .ok_or(ErrorCode::MathOverflow)?
                .checked_div(pool_value as u128)
                .ok_or(ErrorCode::MathOverflow)?;
            u64::try_from(shares_u128).map_err(|_| ErrorCode::MathOverflow)?
        };
        require!(shares > 0, ErrorCode::InvalidAmount);

        // Transfer tokens from depositor to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.depositor_token_account.to_account_info(),
                    to: ctx.accounts.loan_token_vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
        )?;

        // Update depositor position
        let position = &mut ctx.accounts.position;
        if position.shares == 0 {
            // New position
            position.owner = ctx.accounts.depositor.key();
            position.pool = ctx.accounts.pool.key();
            position.bump = ctx.bumps.position;
        }
        position.shares = position
            .shares
            .checked_add(shares)
            .ok_or(ErrorCode::MathOverflow)?;
        position.deposited_amount = position
            .deposited_amount
            .checked_add(amount)
            .ok_or(ErrorCode::MathOverflow)?;
        position.last_deposit_ts = Clock::get()?.unix_timestamp;

        // Update pool
        let pool = &mut ctx.accounts.pool;
        pool.total_deposits = pool
            .total_deposits
            .checked_add(amount)
            .ok_or(ErrorCode::MathOverflow)?;
        pool.total_shares = pool
            .total_shares
            .checked_add(shares)
            .ok_or(ErrorCode::MathOverflow)?;

        emit!(Deposited {
            pool: pool.key(),
            depositor: ctx.accounts.depositor.key(),
            amount,
            shares,
        });
        Ok(())
    }

    /// Withdraw by burning shares. Receives proportional pool value.
    pub fn withdraw(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
        require!(shares > 0, ErrorCode::InvalidAmount);

        let position = &ctx.accounts.position;
        require!(position.shares >= shares, ErrorCode::InsufficientShares);

        let pool = &ctx.accounts.pool;
        let pool_value = pool.total_deposits;

        // Calculate withdrawal amount (u128 to avoid overflow)
        let amount_u128 = (shares as u128)
            .checked_mul(pool_value as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(pool.total_shares as u128)
            .ok_or(ErrorCode::MathOverflow)?;
        let amount = u64::try_from(amount_u128).map_err(|_| ErrorCode::MathOverflow)?;
        require!(amount > 0, ErrorCode::InvalidAmount);

        // Check available liquidity (deposits - borrowed)
        let available = pool
            .total_deposits
            .checked_sub(pool.total_borrowed)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(amount <= available, ErrorCode::InsufficientLiquidity);

        // Transfer from vault to depositor (PDA signer)
        let authority_key = pool.authority.key();
        let seeds = &[
            b"pool".as_ref(),
            authority_key.as_ref(),
            &[pool.bump],
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.loan_token_vault.to_account_info(),
                    to: ctx.accounts.depositor_token_account.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        // Update position
        let position = &mut ctx.accounts.position;
        // Capture pre-mutation values for the proportional reduction math
        // below; computing them BEFORE the share subtraction avoids the
        // post-hoc "add shares back" trick V1/V2 used (which involved an
        // .unwrap() that read confusingly even if mathematically safe).
        let position_shares_before = position.shares;
        let position_deposited_before = position.deposited_amount;
        position.shares = position
            .shares
            .checked_sub(shares)
            .ok_or(ErrorCode::MathOverflow)?;
        // Reduce deposited_amount proportionally — use u128 intermediate so
        // (shares × position.deposited_amount) doesn't overflow u64 for
        // larger LP balances. The V1/V2 form `shares.checked_mul(deposited)`
        // overflowed once shares × deposited crossed ~1.8e19, which is the
        // root cause of the ~0.14 SOL withdraw cap operator hit during the
        // 2026-06-13 remediation. This form has headroom up to u128.
        let deposit_reduction = if position_shares_before == 0 {
            0u64
        } else {
            let num = (shares as u128)
                .checked_mul(position_deposited_before as u128)
                .ok_or(ErrorCode::MathOverflow)?;
            let div = num
                .checked_div(position_shares_before as u128)
                .ok_or(ErrorCode::MathOverflow)?;
            // Saturating cast: a div result larger than position.deposited
            // _amount means the proportional reduction would consume the
            // entire deposited balance — cap there rather than overflow.
            u64::try_from(div).unwrap_or(position_deposited_before)
        };
        position.deposited_amount = position
            .deposited_amount
            .saturating_sub(deposit_reduction);

        // Update pool
        let pool = &mut ctx.accounts.pool;
        pool.total_deposits = pool
            .total_deposits
            .checked_sub(amount)
            .ok_or(ErrorCode::MathOverflow)?;
        pool.total_shares = pool
            .total_shares
            .checked_sub(shares)
            .ok_or(ErrorCode::MathOverflow)?;

        emit!(Withdrawn {
            pool: pool.key(),
            depositor: ctx.accounts.depositor.key(),
            amount,
            shares,
        });
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Loan operations
    // -----------------------------------------------------------------------

    /// Request and instantly fund a loan from the pool.
    ///
    /// `collateral_amount` – raw token units of collateral to lock.
    /// `loan_option`       – tier 0/1/2 within the chosen category.
    /// `collateral_value`  – oracle-supplied value in loan-token units.
    /// `loan_id`           – unique nonce (e.g. unix-ms).
    /// `category`          – 0 = memecoin (30/25/20% LTV @ 2/3/7d),
    ///                       1 = RWA stock/etf/metal (50/60/70% @ 7/15/30d).
    ///                       The cosign authority is responsible for matching
    ///                       this to the on-chain mint category — if a memecoin
    ///                       borrow arrives with category=RWA the higher LTV
    ///                       on a volatile mint becomes a default risk. The
    ///                       authority signature gates that.
    pub fn request_and_fund_loan(
        ctx: Context<RequestLoan>,
        collateral_amount: u64,
        loan_option: u8,
        collateral_value: u64,
        loan_id: u64,
        category: u8,
    ) -> Result<()> {
        // Constraints lifted from RequestLoan struct to keep try_accounts under
        // the BPF 4 KB stack limit. Functionally equivalent.
        require!(
            ctx.accounts.authority.key() == ctx.accounts.pool.authority,
            ErrorCode::Unauthorized
        );
        require!(
            ctx.accounts.borrower_collateral_account.owner == ctx.accounts.borrower.key(),
            ErrorCode::Unauthorized
        );
        require!(
            ctx.accounts.borrower_collateral_account.mint == ctx.accounts.collateral_mint.key(),
            ErrorCode::PriceMintMismatch
        );
        require!(
            ctx.accounts.borrower_loan_token_account.owner == ctx.accounts.borrower.key(),
            ErrorCode::Unauthorized
        );
        require!(
            ctx.accounts.borrower_loan_token_account.mint == ctx.accounts.pool.loan_token_mint,
            ErrorCode::PriceMintMismatch
        );
        require!(
            ctx.accounts.fee_wallet_token_account.mint == ctx.accounts.pool.loan_token_mint,
            ErrorCode::PriceMintMismatch
        );

        require!(!ctx.accounts.pool.paused, ErrorCode::PoolPaused);
        require!(loan_option <= 2, ErrorCode::InvalidLoanOption);
        require!(collateral_amount > 0, ErrorCode::InvalidCollateralAmount);
        require!(collateral_value > 0, ErrorCode::InvalidCollateralValue);
        // Validate category early — before any expensive TWAP / token work —
        // so a bad caller fails cheaply.
        require!(category <= 1, ErrorCode::InvalidCategory);

        // --- v3 TWAP-based price validation ---
        // Replaces v2's single-spot attestation with a time-weighted
        // average over the last TWAP_WINDOW_SECONDS. Refuses to lend
        // when (a) too few samples, (b) too little history elapsed,
        // (c) latest sample stale, or (d) spot price has pumped
        // significantly above the TWAP (in-progress manipulation).
        let feed = &ctx.accounts.price_feed;
        let now = Clock::get()?.unix_timestamp;

        // Freshness — the LATEST sample must be recent.
        let latest = feed.latest().ok_or(ErrorCode::TwapInsufficientHistory)?;
        require!(
            now.checked_sub(latest.timestamp).unwrap_or(i64::MAX) <= MAX_PRICE_STALENESS,
            ErrorCode::StalePriceAttestation
        );

        // Compute TWAP. Refuses if not enough samples in window.
        let (twap, _samples_used, oldest_age) =
            feed.twap(now).ok_or(ErrorCode::TwapInsufficientHistory)?;

        // History-length requirement: oldest sample must be at least
        // MIN_HISTORY_SECONDS old. Otherwise an attacker could spam
        // samples right before borrowing.
        require!(
            oldest_age >= MIN_HISTORY_SECONDS,
            ErrorCode::TwapInsufficientHistory
        );

        // Pump check: if spot (latest sample) is too far above TWAP,
        // we're in an active price-impact event. Refuse the borrow.
        // (We DO allow downward divergence — if spot < TWAP, borrowing
        // against the lower spot value is fine for the protocol.)
        let spot = latest.price_lamports as u128;
        let max_spot = twap
            .checked_mul((BPS_DENOM as u128) + (MAX_SPOT_VS_TWAP_PUMP_BPS as u128))
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOM as u128)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(spot <= max_spot, ErrorCode::PriceImpactPumpDetected);

        // Compute expected collateral value from TWAP — use the LOWER of
        // (TWAP, spot) so we never lend against an inflated spot even
        // within the pump-tolerance window.
        let valuation_price = if spot < twap { spot } else { twap };
        let decimals = ctx.accounts.collateral_mint.decimals;
        let expected_value = (collateral_amount as u128)
            .checked_mul(valuation_price)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(10u128.pow(decimals as u32))
            .ok_or(ErrorCode::MathOverflow)?;

        // Submitted value cannot exceed expected + 3% tolerance (matches
        // v1/v2 tolerance window, but baseline is now TWAP-derived).
        let max_allowed = expected_value
            .checked_mul((BPS_DENOM as u128) + (MAX_VALUE_TOLERANCE_BPS as u128))
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOM as u128)
            .ok_or(ErrorCode::MathOverflow)?;

        require!(
            (collateral_value as u128) <= max_allowed,
            ErrorCode::CollateralValueExceedsAttestation
        );

        let (ltv_bps, fee_bps, duration_days) =
            resolve_tier(category, loan_option).ok_or(ErrorCode::InvalidCategory)?;

        // Compute loan amount from LTV
        let gross_loan = collateral_value
            .checked_mul(ltv_bps)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOM)
            .ok_or(ErrorCode::MathOverflow)?;

        // Compute fee
        let fee = gross_loan
            .checked_mul(fee_bps)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOM)
            .ok_or(ErrorCode::MathOverflow)?;

        let net_loan = gross_loan
            .checked_sub(fee)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(net_loan > 0, ErrorCode::InvalidAmount);

        // Check pool has enough liquidity
        let available = ctx
            .accounts
            .pool
            .total_deposits
            .checked_sub(ctx.accounts.pool.total_borrowed)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(available >= gross_loan, ErrorCode::InsufficientLiquidity);

        let now = Clock::get()?.unix_timestamp;

        // --- Transfer collateral from borrower to vault (Token or Token-2022) ---
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.borrower_collateral_account.to_account_info(),
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                    to: ctx.accounts.collateral_vault.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                },
            ),
            collateral_amount,
            decimals,
        )?;

        // --- Disburse loan tokens from pool vault to borrower ---
        let authority_key = ctx.accounts.pool.authority.key();
        let pool_seeds = &[
            b"pool".as_ref(),
            authority_key.as_ref(),
            &[ctx.accounts.pool.bump],
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.loan_token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.loan_token_vault.to_account_info(),
                    to: ctx.accounts.borrower_loan_token_account.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[pool_seeds],
            ),
            net_loan,
        )?;

        // --- Send fee to protocol fee wallet ---
        if fee > 0 {
            // Split fee: protocol_fee_bps goes to protocol, rest stays in pool
            let protocol_cut = fee
                .checked_mul(ctx.accounts.pool.protocol_fee_bps as u64)
                .ok_or(ErrorCode::MathOverflow)?
                .checked_div(BPS_DENOM)
                .ok_or(ErrorCode::MathOverflow)?;
            // pool_cut stays in the vault → depositors earn it via share appreciation
            if protocol_cut > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.loan_token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.loan_token_vault.to_account_info(),
                            to: ctx.accounts.fee_wallet_token_account.to_account_info(),
                            authority: ctx.accounts.pool.to_account_info(),
                        },
                        &[pool_seeds],
                    ),
                    protocol_cut,
                )?;
            }

            // pool_cut stays in the vault AND must be credited to LPs by
            // bumping pool.total_deposits — otherwise the withdraw math
            // (`shares × total_deposits / total_shares`) silently leaves
            // the yield behind in the vault, unclaimable by LPs. This was
            // the bug that landed V1/V2 with ~20 SOL of stranded LP yield
            // accumulating in vault excess; V3 honors the "share
            // appreciation" promise that the V1/V2 comments made but the
            // code did not deliver.
            let pool_cut = fee
                .checked_sub(protocol_cut)
                .ok_or(ErrorCode::MathOverflow)?;

            let pool = &mut ctx.accounts.pool;
            pool.total_fees_earned = pool
                .total_fees_earned
                .checked_add(fee)
                .ok_or(ErrorCode::MathOverflow)?;
            // Bump total_deposits by pool_cut so the share-value denominator
            // reflects the just-retained LP yield. Done at borrow time
            // because the fee is realized then (taken up-front from
            // gross_loan, not contingent on repay).
            pool.total_deposits = pool
                .total_deposits
                .checked_add(pool_cut)
                .ok_or(ErrorCode::MathOverflow)?;
        }

        // --- Populate loan account ---
        let loan = &mut ctx.accounts.loan;
        loan.loan_id = loan_id;
        loan.borrower = ctx.accounts.borrower.key();
        loan.pool = ctx.accounts.pool.key();
        loan.collateral_mint = ctx.accounts.collateral_mint.key();
        loan.collateral_vault = ctx.accounts.collateral_vault.key();
        loan.collateral_amount = collateral_amount;
        loan.loan_amount = net_loan;
        loan.repay_amount = gross_loan; // borrower must repay the full gross amount
        loan.transaction_fee = fee;
        loan.ltv_bps = ltv_bps as u16;
        loan.duration_days = duration_days as u8;
        // Persist category so extend_loan / partial-repay can resolve the
        // correct tier ladder later WITHOUT having to look up the mint
        // category from off-chain again. Avoids "what tier is this" round-
        // trips that bit V1/V2 in the limit-close engine after migration 040.
        loan.category = category;
        loan.start_timestamp = now;
        loan.due_timestamp = now
            .checked_add(duration_days.checked_mul(SECONDS_PER_DAY).unwrap())
            .ok_or(ErrorCode::MathOverflow)?;
        loan.status = LoanStatus::Active;
        loan.collateral_value_at_start = collateral_value;
        loan.bump = ctx.bumps.loan;
        loan.vault_bump = ctx.bumps.collateral_vault;
        // v4 in-vault auto-sell state. At borrow time the full collateral
        // is SPL tokens and there is no SOL in the loan vault yet.
        loan.current_collateral_amount = collateral_amount;
        loan.sol_proceeds_amount = 0;
        loan.auto_sells_fired = 0;

        // Update pool stats
        let pool = &mut ctx.accounts.pool;
        pool.total_borrowed = pool
            .total_borrowed
            .checked_add(gross_loan)
            .ok_or(ErrorCode::MathOverflow)?;
        pool.total_loans_issued = pool
            .total_loans_issued
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;

        emit!(LoanFunded {
            pool: pool.key(),
            loan: ctx.accounts.loan.key(),
            borrower: ctx.accounts.borrower.key(),
            collateral_mint: ctx.accounts.collateral_mint.key(),
            collateral_amount,
            loan_amount: net_loan,
            fee,
            ltv_bps: ltv_bps as u16,
            duration_days: duration_days as u8,
            category,
        });
        Ok(())
    }

    /// Repay loan in full; collateral returned to borrower.
    pub fn repay_loan(ctx: Context<RepayLoan>) -> Result<()> {
        let loan = &ctx.accounts.loan;
        require!(loan.status == LoanStatus::Active, ErrorCode::LoanNotActive);

        let repay_amount = loan.repay_amount;

        // Borrower sends repayment to pool vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.loan_token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.borrower_loan_token_account.to_account_info(),
                    to: ctx.accounts.loan_token_vault.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                },
            ),
            repay_amount,
        )?;

        // v4: return whatever is currently in the loan vault. After
        // zero or more convert_collateral_slice calls, the vault may
        // hold a mix of remaining SPL collateral + accumulated SOL.
        // current_collateral_amount = SPL still in vault (0 after full
        // auto-sell). sol_proceeds_amount = SOL accumulated from
        // auto-sells. Either or both can be zero.
        let loan_key = ctx.accounts.loan.key();
        let vault_seeds = &[
            b"collateral-vault".as_ref(),
            loan_key.as_ref(),
            &[loan.vault_bump],
        ];
        let collateral_decimals = ctx.accounts.collateral_mint.decimals;

        // 1. Return any remaining SPL collateral.
        if loan.current_collateral_amount > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.collateral_vault.to_account_info(),
                        mint: ctx.accounts.collateral_mint.to_account_info(),
                        to: ctx.accounts.borrower_collateral_account.to_account_info(),
                        authority: ctx.accounts.collateral_vault.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                loan.current_collateral_amount,
                collateral_decimals,
            )?;
        }

        // 2. Return any accumulated SOL proceeds (wSOL held in a vault-
        //    authority wSOL ATA — same authority/seeds as the SPL vault).
        //    We transfer wSOL directly to the borrower's loan-token ATA.
        //    The borrower can unwrap to native SOL via the standard SPL
        //    close-account instruction off-chain if they want native.
        if loan.sol_proceeds_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.loan_token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.sol_proceeds_vault.to_account_info(),
                        to: ctx.accounts.borrower_loan_token_account.to_account_info(),
                        authority: ctx.accounts.collateral_vault.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                loan.sol_proceeds_amount,
            )?;
        }

        // Update loan
        let loan = &mut ctx.accounts.loan;
        loan.current_collateral_amount = 0;
        loan.sol_proceeds_amount = 0;
        loan.status = LoanStatus::Repaid;

        // Update pool — principal returns, increasing available liquidity
        let pool = &mut ctx.accounts.pool;
        pool.total_borrowed = pool
            .total_borrowed
            .checked_sub(loan.repay_amount)
            .ok_or(ErrorCode::MathOverflow)?;
        // The interest portion (repay_amount was already accounted for in total_deposits
        // through the fee split at origination). The repayment going back to the vault
        // restores the borrowed principal.
        // Net yield for depositors = pool_cut of fees (already realized at borrow time).

        emit!(LoanRepaid {
            pool: pool.key(),
            loan: ctx.accounts.loan.key(),
            borrower: ctx.accounts.borrower.key(),
            repay_amount,
        });
        Ok(())
    }

    /// Partial repayment — reduce outstanding balance, collateral stays locked.
    pub fn partial_repay(ctx: Context<PartialRepay>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        let loan = &ctx.accounts.loan;
        require!(loan.status == LoanStatus::Active, ErrorCode::LoanNotActive);
        require!(amount <= loan.repay_amount, ErrorCode::InvalidAmount);

        // Transfer repayment
        token::transfer(
            CpiContext::new(
                ctx.accounts.loan_token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.borrower_loan_token_account.to_account_info(),
                    to: ctx.accounts.loan_token_vault.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                },
            ),
            amount,
        )?;

        let loan_key = ctx.accounts.loan.key();
        let loan = &mut ctx.accounts.loan;
        loan.repay_amount = loan
            .repay_amount
            .checked_sub(amount)
            .ok_or(ErrorCode::MathOverflow)?;
        let remaining = loan.repay_amount;

        let pool = &mut ctx.accounts.pool;
        pool.total_borrowed = pool
            .total_borrowed
            .checked_sub(amount)
            .ok_or(ErrorCode::MathOverflow)?;

        emit!(PartialRepayment {
            loan: loan_key,
            amount,
            remaining,
        });
        Ok(())
    }

    /// Add more collateral to an active loan (no fee).
    pub fn add_collateral(ctx: Context<AddCollateral>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        let loan = &ctx.accounts.loan;
        require!(loan.status == LoanStatus::Active, ErrorCode::LoanNotActive);

        let collateral_decimals = ctx.accounts.collateral_mint.decimals;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.borrower_collateral_account.to_account_info(),
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                    to: ctx.accounts.collateral_vault.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                },
            ),
            amount,
            collateral_decimals,
        )?;

        let loan_key = ctx.accounts.loan.key();
        let loan = &mut ctx.accounts.loan;
        loan.collateral_amount = loan
            .collateral_amount
            .checked_add(amount)
            .ok_or(ErrorCode::MathOverflow)?;
        let new_total = loan.collateral_amount;

        emit!(CollateralAdded {
            loan: loan_key,
            amount,
            new_total,
        });
        Ok(())
    }

    /// Extend loan by its original duration, paying the tier fee again.
    pub fn extend_loan(ctx: Context<ExtendLoan>) -> Result<()> {
        let loan = &ctx.accounts.loan;
        require!(loan.status == LoanStatus::Active, ErrorCode::LoanNotActive);

        // Resolve tier from the loan's stored (category, option) — the option
        // is derived from ltv_bps within the category's ladder. RWA Standard
        // (70%) and memecoin Express (30%) have distinct ltv_bps so the
        // option-from-ltv inference inside resolve_tier_for_loan is unique
        // per category.
        let (_, fee_bps, duration_days) =
            resolve_tier_for_loan(loan.category, loan.ltv_bps)
                .ok_or(ErrorCode::InvalidLoanOption)?;

        let extension_fee = loan
            .repay_amount
            .checked_mul(fee_bps)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOM)
            .ok_or(ErrorCode::MathOverflow)?;

        // Borrower pays extension fee
        token::transfer(
            CpiContext::new(
                ctx.accounts.loan_token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.borrower_loan_token_account.to_account_info(),
                    to: ctx.accounts.loan_token_vault.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                },
            ),
            extension_fee,
        )?;

        // Split fee same as origination
        let protocol_cut = extension_fee
            .checked_mul(ctx.accounts.pool.protocol_fee_bps as u64)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOM)
            .ok_or(ErrorCode::MathOverflow)?;

        if protocol_cut > 0 {
            let authority_key = ctx.accounts.pool.authority.key();
            let pool_seeds = &[
                b"pool".as_ref(),
                authority_key.as_ref(),
                &[ctx.accounts.pool.bump],
            ];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.loan_token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.loan_token_vault.to_account_info(),
                        to: ctx.accounts.fee_wallet_token_account.to_account_info(),
                        authority: ctx.accounts.pool.to_account_info(),
                    },
                    &[pool_seeds],
                ),
                protocol_cut,
            )?;
        }

        let loan_key = ctx.accounts.loan.key();
        let loan = &mut ctx.accounts.loan;
        let extension = duration_days
            .checked_mul(SECONDS_PER_DAY)
            .ok_or(ErrorCode::MathOverflow)?;
        loan.due_timestamp = loan
            .due_timestamp
            .checked_add(extension)
            .ok_or(ErrorCode::MathOverflow)?;
        let new_due = loan.due_timestamp;

        // Credit LP yield from the retained portion of the extension fee.
        // Same rationale as request_and_fund_loan (above): pool_cut sits in
        // the vault; without bumping total_deposits the withdraw math leaves
        // it stranded. Done here AFTER the protocol_cut transfer is known so
        // pool_cut is exact.
        let pool_cut = extension_fee
            .checked_sub(protocol_cut)
            .ok_or(ErrorCode::MathOverflow)?;

        let pool = &mut ctx.accounts.pool;
        pool.total_fees_earned = pool
            .total_fees_earned
            .checked_add(extension_fee)
            .ok_or(ErrorCode::MathOverflow)?;
        pool.total_deposits = pool
            .total_deposits
            .checked_add(pool_cut)
            .ok_or(ErrorCode::MathOverflow)?;

        emit!(LoanExtended {
            loan: loan_key,
            new_due_timestamp: new_due,
            extension_fee,
        });
        Ok(())
    }

    /// Liquidate an overdue loan. **Permissionless** — any wallet (keeper) can
    /// call this. The keeper receives `keeper_reward_bps` of the seized
    /// collateral as a bounty; the remainder goes to the pool authority for
    /// off-chain swap and pool recovery.
    pub fn liquidate_loan(ctx: Context<LiquidateLoan>) -> Result<()> {
        let loan = &ctx.accounts.loan;
        require!(loan.status == LoanStatus::Active, ErrorCode::LoanNotActive);

        let now = Clock::get()?.unix_timestamp;
        require!(now > loan.due_timestamp, ErrorCode::LoanNotDue);

        let collateral_amount = loan.collateral_amount;
        let keeper_reward_bps = ctx.accounts.pool.keeper_reward_bps as u64;

        // Calculate keeper bounty
        let keeper_reward = collateral_amount
            .checked_mul(keeper_reward_bps)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOM)
            .ok_or(ErrorCode::MathOverflow)?;
        let authority_amount = collateral_amount
            .checked_sub(keeper_reward)
            .ok_or(ErrorCode::MathOverflow)?;

        let loan_key = ctx.accounts.loan.key();
        let vault_seeds = &[
            b"collateral-vault".as_ref(),
            loan_key.as_ref(),
            &[loan.vault_bump],
        ];
        let collateral_decimals = ctx.accounts.collateral_mint.decimals;

        // Transfer keeper's bounty (Token or Token-2022)
        if keeper_reward > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.collateral_vault.to_account_info(),
                        mint: ctx.accounts.collateral_mint.to_account_info(),
                        to: ctx.accounts.keeper_collateral_account.to_account_info(),
                        authority: ctx.accounts.collateral_vault.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                keeper_reward,
                collateral_decimals,
            )?;
        }

        // Transfer remainder to authority (Token or Token-2022)
        if authority_amount > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.collateral_vault.to_account_info(),
                        mint: ctx.accounts.collateral_mint.to_account_info(),
                        to: ctx.accounts.authority_collateral_account.to_account_info(),
                        authority: ctx.accounts.collateral_vault.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                authority_amount,
                collateral_decimals,
            )?;
        }

        let pool_key = ctx.accounts.pool.key();
        let repay_amount = ctx.accounts.loan.repay_amount;
        let borrower = ctx.accounts.loan.borrower;
        let keeper = ctx.accounts.keeper.key();

        let loan = &mut ctx.accounts.loan;
        loan.status = LoanStatus::Liquidated;

        // Write off the borrowed amount (pool takes the loss; depositors share it)
        let pool = &mut ctx.accounts.pool;
        pool.total_borrowed = pool
            .total_borrowed
            .checked_sub(repay_amount)
            .ok_or(ErrorCode::MathOverflow)?;
        pool.total_deposits = pool
            .total_deposits
            .checked_sub(repay_amount)
            .ok_or(ErrorCode::MathOverflow)?;
        pool.total_liquidations = pool
            .total_liquidations
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;

        emit!(LoanLiquidated {
            pool: pool_key,
            loan: loan_key,
            borrower,
            keeper,
            collateral_seized: collateral_amount,
            keeper_reward,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts (context structs)
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + LendingPool::INIT_SPACE,
        seeds = [b"pool", authority.key().as_ref()],
        bump,
    )]
    pub pool: Account<'info, LendingPool>,

    #[account(
        init,
        payer = authority,
        token::mint = loan_token_mint,
        token::authority = pool,
        seeds = [b"loan-token-vault", pool.key().as_ref()],
        bump,
    )]
    pub loan_token_vault: Account<'info, TokenAccount>,

    pub loan_token_mint: Account<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        mut,
        has_one = authority,
    )]
    pub pool: Account<'info, LendingPool>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminWithdraw<'info> {
    #[account(
        mut,
        has_one = authority,
    )]
    pub pool: Account<'info, LendingPool>,

    #[account(
        mut,
        seeds = [b"loan-token-vault", pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub loan_token_vault: Account<'info, TokenAccount>,

    /// Authority's wSOL token account to receive the funds.
    #[account(
        mut,
        constraint = authority_token_account.owner == authority.key(),
        constraint = authority_token_account.mint == pool.loan_token_mint,
    )]
    pub authority_token_account: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitializePriceFeed<'info> {
    #[account(
        has_one = authority,
    )]
    pub pool: Account<'info, LendingPool>,

    /// Accept both legacy Token and Token-2022 mints.
    pub mint: Box<InterfaceAccount<'info, MintIfc>>,

    #[account(
        init,
        payer = authority,
        space = 8 + PriceHistory::INIT_SPACE,
        seeds = [b"price_v3", mint.key().as_ref(), pool.key().as_ref()],
        bump,
    )]
    pub price_feed: Account<'info, PriceHistory>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePrice<'info> {
    #[account(
        has_one = authority,
    )]
    pub pool: Account<'info, LendingPool>,

    #[account(
        mut,
        seeds = [b"price_v3", price_feed.mint.as_ref(), pool.key().as_ref()],
        bump = price_feed.bump,
        constraint = price_feed.authority == authority.key() @ ErrorCode::Unauthorized,
    )]
    pub price_feed: Account<'info, PriceHistory>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub pool: Account<'info, LendingPool>,

    #[account(
        mut,
        seeds = [b"loan-token-vault", pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub loan_token_vault: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = depositor,
        space = 8 + DepositorPosition::INIT_SPACE,
        seeds = [b"position", pool.key().as_ref(), depositor.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, DepositorPosition>,

    #[account(
        mut,
        constraint = depositor_token_account.owner == depositor.key(),
        constraint = depositor_token_account.mint == pool.loan_token_mint,
    )]
    pub depositor_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub pool: Account<'info, LendingPool>,

    #[account(
        mut,
        seeds = [b"loan-token-vault", pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub loan_token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"position", pool.key().as_ref(), depositor.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == depositor.key() @ ErrorCode::Unauthorized,
    )]
    pub position: Account<'info, DepositorPosition>,

    #[account(
        mut,
        constraint = depositor_token_account.owner == depositor.key(),
        constraint = depositor_token_account.mint == pool.loan_token_mint,
    )]
    pub depositor_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(collateral_amount: u64, loan_option: u8, collateral_value: u64, loan_id: u64, category: u8)]
pub struct RequestLoan<'info> {
    #[account(mut)]
    pub pool: Box<Account<'info, LendingPool>>,

    #[account(
        mut,
        seeds = [b"loan-token-vault", pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub loan_token_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = borrower,
        space = 8 + Loan::INIT_SPACE,
        seeds = [b"loan", borrower.key().as_ref(), &loan_id.to_le_bytes()],
        bump,
    )]
    pub loan: Box<Account<'info, Loan>>,

    #[account(
        init,
        payer = borrower,
        token::mint = collateral_mint,
        token::authority = collateral_vault,
        token::token_program = token_program,
        seeds = [b"collateral-vault", loan.key().as_ref()],
        bump,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    pub collateral_mint: Box<InterfaceAccount<'info, MintIfc>>,

    // Constraints moved to handler body to reduce try_accounts() stack frame.
    // Anchor's auto-generated try_accounts otherwise overflows 4 KB on BPF.
    #[account(mut)]
    pub borrower_collateral_account: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    #[account(mut)]
    pub borrower_loan_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub fee_wallet_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub borrower: Signer<'info>,

    /// Pool authority must co-sign every borrow to attest the collateral value.
    pub authority: Signer<'info>,

    /// On-chain price attestation for the collateral mint. PDA seeds already
    /// enforce mint+pool linkage so duplicate constraints removed.
    #[account(
        seeds = [b"price_v3", collateral_mint.key().as_ref(), pool.key().as_ref()],
        bump = price_feed.bump,
    )]
    pub price_feed: Box<Account<'info, PriceHistory>>,

    pub system_program: Program<'info, System>,
    /// Used for collateral vault init + collateral transfers. Accepts both
    /// legacy SPL Token and Token-2022 mints.
    pub token_program: Interface<'info, TokenInterface>,
    /// Used for loan token (wSOL) transfers from pool vault. Always legacy.
    pub loan_token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RepayLoan<'info> {
    #[account(mut)]
    pub pool: Account<'info, LendingPool>,

    #[account(
        mut,
        seeds = [b"loan-token-vault", pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub loan_token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        has_one = borrower,
        has_one = pool,
        has_one = collateral_mint,
    )]
    pub loan: Account<'info, Loan>,

    /// Collateral mint — needed for transfer_checked (Token-2022 compat).
    pub collateral_mint: Box<InterfaceAccount<'info, MintIfc>>,

    #[account(
        mut,
        seeds = [b"collateral-vault", loan.key().as_ref()],
        bump = loan.vault_bump,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    #[account(
        mut,
        constraint = borrower_collateral_account.owner == borrower.key(),
        constraint = borrower_collateral_account.mint == loan.collateral_mint,
    )]
    pub borrower_collateral_account: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    #[account(
        mut,
        constraint = borrower_loan_token_account.owner == borrower.key(),
        constraint = borrower_loan_token_account.mint == pool.loan_token_mint,
    )]
    pub borrower_loan_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub borrower: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub loan_token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct PartialRepay<'info> {
    #[account(mut)]
    pub pool: Account<'info, LendingPool>,

    #[account(
        mut,
        seeds = [b"loan-token-vault", pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub loan_token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        has_one = borrower,
        has_one = pool,
    )]
    pub loan: Account<'info, Loan>,

    #[account(
        mut,
        constraint = borrower_loan_token_account.owner == borrower.key(),
        constraint = borrower_loan_token_account.mint == pool.loan_token_mint,
    )]
    pub borrower_loan_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub borrower: Signer<'info>,

    pub loan_token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AddCollateral<'info> {
    #[account(
        mut,
        has_one = borrower,
        has_one = collateral_mint,
    )]
    pub loan: Account<'info, Loan>,

    /// Collateral mint — needed for transfer_checked (Token-2022 compat).
    pub collateral_mint: Box<InterfaceAccount<'info, MintIfc>>,

    #[account(
        mut,
        seeds = [b"collateral-vault", loan.key().as_ref()],
        bump = loan.vault_bump,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    #[account(
        mut,
        constraint = borrower_collateral_account.owner == borrower.key(),
        constraint = borrower_collateral_account.mint == loan.collateral_mint,
    )]
    pub borrower_collateral_account: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    #[account(mut)]
    pub borrower: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ExtendLoan<'info> {
    #[account(mut)]
    pub pool: Account<'info, LendingPool>,

    #[account(
        mut,
        seeds = [b"loan-token-vault", pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub loan_token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        has_one = borrower,
        has_one = pool,
    )]
    pub loan: Account<'info, Loan>,

    #[account(
        mut,
        constraint = borrower_loan_token_account.owner == borrower.key(),
        constraint = borrower_loan_token_account.mint == pool.loan_token_mint,
    )]
    pub borrower_loan_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = fee_wallet_token_account.mint == pool.loan_token_mint,
    )]
    pub fee_wallet_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub borrower: Signer<'info>,

    pub loan_token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct LiquidateLoan<'info> {
    #[account(mut)]
    pub pool: Account<'info, LendingPool>,

    #[account(
        mut,
        has_one = pool,
        has_one = collateral_mint,
    )]
    pub loan: Account<'info, Loan>,

    /// Collateral mint — needed for transfer_checked (Token-2022 compat).
    pub collateral_mint: Box<InterfaceAccount<'info, MintIfc>>,

    #[account(
        mut,
        seeds = [b"collateral-vault", loan.key().as_ref()],
        bump = loan.vault_bump,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    /// Keeper's token account — receives the keeper bounty portion
    #[account(
        mut,
        constraint = keeper_collateral_account.owner == keeper.key(),
        constraint = keeper_collateral_account.mint == loan.collateral_mint,
    )]
    pub keeper_collateral_account: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    /// Authority's token account — receives the remaining collateral
    #[account(
        mut,
        constraint = authority_collateral_account.owner == pool.authority,
        constraint = authority_collateral_account.mint == loan.collateral_mint,
    )]
    pub authority_collateral_account: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    /// The keeper (liquidator) — permissionless, any wallet can sign
    #[account(mut)]
    pub keeper: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct LendingPool {
    /// Pool creator / admin
    pub authority: Pubkey,
    /// PDA token account holding wSOL for loans
    pub loan_token_vault: Pubkey,
    /// Mint of the loan token (wSOL)
    pub loan_token_mint: Pubkey,
    /// Protocol's cut of fees in basis points (e.g. 2000 = 20%)
    pub protocol_fee_bps: u16,
    /// Keeper reward for liquidations in basis points (e.g. 500 = 5% of collateral)
    pub keeper_reward_bps: u16,
    /// Total wSOL deposited by liquidity providers
    pub total_deposits: u64,
    /// Total outstanding shares
    pub total_shares: u64,
    /// Total wSOL currently lent out
    pub total_borrowed: u64,
    /// Cumulative fees earned
    pub total_fees_earned: u64,
    /// Cumulative loans issued
    pub total_loans_issued: u64,
    /// Cumulative liquidations
    pub total_liquidations: u64,
    /// Whether new borrows are paused
    pub paused: bool,
    /// PDA bump
    pub bump: u8,
    /// Vault PDA bump
    pub vault_bump: u8,
}

/// One sample in the rolling price history. Compact 16-byte layout.
#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, InitSpace)]
pub struct PriceSample {
    pub price_lamports: u64,
    pub timestamp: i64,
}

/// Rolling ring buffer of price samples per mint. Replaces the v2
/// `PriceHistory` single-spot design. TWAP is computed over the
/// samples within `TWAP_WINDOW_SECONDS`; samples outside the window
/// remain in the buffer (so we don't lose capacity) but are excluded
/// from the average.
///
/// Updates are append-only at `head_index`, which wraps around. After
/// the buffer fills once, `count = PRICE_HISTORY_CAPACITY` and
/// `head_index` keeps advancing modulo capacity (oldest slot is
/// overwritten next). Order in the array is not chronological after
/// wrap — readers must use `head_index` + `count` to walk it.
#[account]
#[derive(InitSpace)]
pub struct PriceHistory {
    /// Token mint this history covers
    pub mint: Pubkey,
    /// Pool this history belongs to
    pub pool: Pubkey,
    /// Authority allowed to append samples
    pub authority: Pubkey,
    /// Index of the slot that will receive the NEXT sample (wraps).
    pub head_index: u8,
    /// How many slots in `samples` are populated (caps at capacity).
    pub count: u8,
    /// Reserved for future use / forces alignment.
    pub _padding: [u8; 6],
    /// Ring buffer of samples. Newest sample lives at
    /// `samples[(head_index - 1 + capacity) % capacity]` when count > 0.
    pub samples: [PriceSample; PRICE_HISTORY_CAPACITY],
    /// PDA bump
    pub bump: u8,
}

impl PriceHistory {
    /// Return the most recent sample, or None if the buffer is empty.
    pub fn latest(&self) -> Option<PriceSample> {
        if self.count == 0 {
            return None;
        }
        let cap = PRICE_HISTORY_CAPACITY as u8;
        let idx = ((self.head_index + cap - 1) % cap) as usize;
        Some(self.samples[idx])
    }

    /// Compute the time-weighted average price over `TWAP_WINDOW_SECONDS`,
    /// ending at `now`. Returns:
    ///   Some((twap, samples_used, oldest_sample_age_seconds))
    ///   None if fewer than MIN_SAMPLES_FOR_TWAP fall inside the window.
    ///
    /// Weighting: each sample's price is weighted by the time-gap to the
    /// NEXT sample (or `now` for the most recent). This is a standard
    /// time-weighted average — a price that held for 10 min counts more
    /// than one that held for 30 sec.
    pub fn twap(&self, now: i64) -> Option<(u128, u8, i64)> {
        if self.count == 0 {
            return None;
        }
        let cap = PRICE_HISTORY_CAPACITY as u8;

        // Collect samples in chronological order from oldest to newest.
        let mut ordered: [PriceSample; PRICE_HISTORY_CAPACITY] =
            [PriceSample { price_lamports: 0, timestamp: 0 }; PRICE_HISTORY_CAPACITY];
        let mut n = 0usize;
        // Start at the slot just AFTER head (oldest slot when buffer full).
        let start = if self.count >= cap {
            self.head_index as usize
        } else {
            0
        };
        let cnt = self.count as usize;
        for i in 0..cnt {
            let idx = (start + i) % (PRICE_HISTORY_CAPACITY);
            ordered[n] = self.samples[idx];
            n += 1;
        }

        // Filter to window: keep samples with timestamp >= now - WINDOW.
        let cutoff = now.saturating_sub(TWAP_WINDOW_SECONDS);
        let mut in_window: [PriceSample; PRICE_HISTORY_CAPACITY] =
            [PriceSample { price_lamports: 0, timestamp: 0 }; PRICE_HISTORY_CAPACITY];
        let mut k = 0usize;
        for i in 0..n {
            if ordered[i].timestamp >= cutoff {
                in_window[k] = ordered[i];
                k += 1;
            }
        }
        if k < MIN_SAMPLES_FOR_TWAP as usize {
            return None;
        }

        // Time-weighted sum.
        let mut weighted: u128 = 0;
        let mut total_weight: i64 = 0;
        for i in 0..k {
            let end = if i + 1 < k {
                in_window[i + 1].timestamp
            } else {
                now
            };
            let weight = end.saturating_sub(in_window[i].timestamp).max(0);
            if weight == 0 {
                continue;
            }
            weighted = weighted.saturating_add(
                (in_window[i].price_lamports as u128).saturating_mul(weight as u128),
            );
            total_weight = total_weight.saturating_add(weight);
        }
        if total_weight <= 0 {
            return None;
        }
        let twap = weighted / total_weight as u128;
        let oldest_age = now.saturating_sub(in_window[0].timestamp);
        Some((twap, k as u8, oldest_age))
    }

    /// Append a new sample at head_index (wrap-around).
    pub fn append(&mut self, sample: PriceSample) {
        let cap = PRICE_HISTORY_CAPACITY as u8;
        self.samples[self.head_index as usize] = sample;
        self.head_index = (self.head_index + 1) % cap;
        if self.count < cap {
            self.count += 1;
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct DepositorPosition {
    /// Depositor wallet
    pub owner: Pubkey,
    /// Which pool this position belongs to
    pub pool: Pubkey,
    /// Pool shares held
    pub shares: u64,
    /// Cumulative amount deposited (for UI/analytics)
    pub deposited_amount: u64,
    /// Last deposit timestamp
    pub last_deposit_ts: i64,
    /// PDA bump
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Loan {
    /// Unique identifier
    pub loan_id: u64,
    /// Borrower's wallet
    pub borrower: Pubkey,
    /// Pool this loan was issued from
    pub pool: Pubkey,
    /// Collateral token mint
    pub collateral_mint: Pubkey,
    /// PDA vault holding collateral
    pub collateral_vault: Pubkey,
    /// Collateral amount locked (raw units)
    pub collateral_amount: u64,
    /// Net loan amount borrower received
    pub loan_amount: u64,
    /// Amount borrower must repay (decreases with partial repayments)
    pub repay_amount: u64,
    /// Fee charged at origination
    pub transaction_fee: u64,
    /// LTV in basis points. Memecoin: 2000/2500/3000.
    /// RWA: 5000/6000/7000. Tier resolved within the loan's category.
    pub ltv_bps: u16,
    /// Loan duration in days
    pub duration_days: u8,
    /// When loan was funded
    pub start_timestamp: i64,
    /// When repayment is due
    pub due_timestamp: i64,
    /// Loan status
    pub status: LoanStatus,
    /// Collateral value at loan creation (in loan token units)
    pub collateral_value_at_start: u64,
    /// PDA bump for loan account
    pub bump: u8,
    /// PDA bump for collateral vault
    pub vault_bump: u8,
    /// Loan category (0 = memecoin, 1 = RWA). Used by extend_loan to
    /// pick the right tier ladder without a round-trip to off-chain
    /// metadata.
    pub category: u8,
    // ── v4 additions: in-vault auto-sell state ──────────────────────
    /// SPL collateral remaining in the vault. Equals collateral_amount
    /// at borrow time, decreases as convert_collateral_slice fires.
    /// Reaches 0 when the position is fully auto-sold. At repay /
    /// liquidation time, whatever is here gets returned to the borrower
    /// (alongside sol_proceeds_amount).
    pub current_collateral_amount: u64,
    /// SOL accumulated from auto-sells (in lamports, net of the 1%
    /// protocol fee). Sits in a vault-owned wSOL token account whose
    /// authority is the loan's collateral_vault PDA, so the engine
    /// can credit it on conversions but only the borrower can claim it
    /// (via repay) or the keeper can claim it (via liquidate).
    pub sol_proceeds_amount: u64,
    /// Number of times convert_collateral_slice has fired against this
    /// loan. Diagnostics only — no contract invariant depends on it.
    pub auto_sells_fired: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum LoanStatus {
    Active,
    Repaid,
    Liquidated,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub protocol_fee_bps: u16,
}

#[event]
pub struct Deposited {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct Withdrawn {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct LoanFunded {
    pub pool: Pubkey,
    pub loan: Pubkey,
    pub borrower: Pubkey,
    pub collateral_mint: Pubkey,
    pub collateral_amount: u64,
    pub loan_amount: u64,
    pub fee: u64,
    pub ltv_bps: u16,
    pub duration_days: u8,
    /// 0 = memecoin, 1 = RWA. Off-chain indexers can filter loans
    /// by category without joining against the off-chain mint table.
    pub category: u8,
}

#[event]
pub struct LoanRepaid {
    pub pool: Pubkey,
    pub loan: Pubkey,
    pub borrower: Pubkey,
    pub repay_amount: u64,
}

#[event]
pub struct PartialRepayment {
    pub loan: Pubkey,
    pub amount: u64,
    pub remaining: u64,
}

#[event]
pub struct CollateralAdded {
    pub loan: Pubkey,
    pub amount: u64,
    pub new_total: u64,
}

#[event]
pub struct LoanExtended {
    pub loan: Pubkey,
    pub new_due_timestamp: i64,
    pub extension_fee: u64,
}

#[event]
pub struct PriceFeedInitialized {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct PriceUpdated {
    pub mint: Pubkey,
    pub price_lamports: u64,
    pub confidence_bps: u16,
    pub timestamp: i64,
}

#[event]
pub struct LoanLiquidated {
    pub pool: Pubkey,
    pub loan: Pubkey,
    pub borrower: Pubkey,
    pub keeper: Pubkey,
    pub collateral_seized: u64,
    pub keeper_reward: u64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid loan option. Must be 0, 1, or 2.")]
    InvalidLoanOption,
    #[msg("Invalid collateral amount.")]
    InvalidCollateralAmount,
    #[msg("Invalid collateral value.")]
    InvalidCollateralValue,
    #[msg("Invalid amount.")]
    InvalidAmount,
    #[msg("Math overflow.")]
    MathOverflow,
    #[msg("Insufficient pool liquidity.")]
    InsufficientLiquidity,
    #[msg("Loan is not active.")]
    LoanNotActive,
    #[msg("Loan is not yet due for liquidation.")]
    LoanNotDue,
    #[msg("Unauthorized.")]
    Unauthorized,
    #[msg("Protocol fee too high (max 50%).")]
    FeeTooHigh,
    #[msg("Insufficient shares.")]
    InsufficientShares,
    #[msg("Pool is paused.")]
    PoolPaused,
    #[msg("Keeper reward too high (max 20%).")]
    KeeperRewardTooHigh,
    #[msg("Price attestation is stale (older than 2 minutes).")]
    StalePriceAttestation,
    #[msg("Collateral value exceeds attested price beyond tolerance.")]
    CollateralValueExceedsAttestation,
    #[msg("Price attestation mint does not match collateral mint.")]
    PriceMintMismatch,
    #[msg("TWAP requires more price history than is currently available.")]
    TwapInsufficientHistory,
    #[msg("Spot price is too far above the TWAP — pump detected, refusing to lend.")]
    PriceImpactPumpDetected,
    #[msg("Price sample timestamp went backwards — clock skew or replay.")]
    PriceTimestampWentBackwards,
    #[msg("Invalid category. Must be 0 (memecoin) or 1 (RWA).")]
    InvalidCategory,
    #[msg("admin_withdraw refused: would drain share-backed LP deposits. Only excess (vault_balance - total_deposits) is admin-withdrawable.")]
    AdminWithdrawWouldDrainLpFunds,
}
