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

declare_id!("4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh"); // fresh program ID 2026-05-29

/// Basis-point helpers
const BPS_DENOM: u64 = 10_000;

/// Loan tier configuration (matches existing protocol)
/// Option 0: Express – 30% LTV, 2 days, 3% fee
/// Option 1: Quick   – 25% LTV, 3 days, 2% fee
/// Option 2: Standard– 20% LTV, 7 days, 1.5% fee
const TIER_LTV_BPS: [u64; 3] = [3_000, 2_500, 2_000];
const TIER_DURATION_DAYS: [i64; 3] = [2, 3, 7];
const TIER_FEE_BPS: [u64; 3] = [300, 200, 150];

const SECONDS_PER_DAY: i64 = 86_400;

/// Maximum age (seconds) of a price attestation before it's rejected.
const MAX_PRICE_STALENESS: i64 = 120; // 2 minutes

/// Maximum tolerance (bps) that submitted collateral_value can exceed attested price.
/// 300 = 3% — caller cannot claim value more than 3% above the attested price.
const MAX_VALUE_TOLERANCE_BPS: u64 = 300;

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
    pub fn initialize_price_feed(ctx: Context<InitializePriceFeed>) -> Result<()> {
        let feed = &mut ctx.accounts.price_feed;
        feed.mint = ctx.accounts.mint.key();
        feed.pool = ctx.accounts.pool.key();
        feed.authority = ctx.accounts.authority.key();
        feed.price_lamports = 0;
        feed.timestamp = 0;
        feed.confidence_bps = 0;
        feed.bump = ctx.bumps.price_feed;

        emit!(PriceFeedInitialized {
            mint: feed.mint,
            pool: feed.pool,
            authority: feed.authority,
        });
        Ok(())
    }

    /// Update the attested price for a token. Only the pool authority can call this.
    /// The bot calls this periodically with fresh Jupiter prices.
    pub fn update_price(
        ctx: Context<UpdatePrice>,
        price_lamports: u64,
        confidence_bps: u16,
    ) -> Result<()> {
        require!(price_lamports > 0, ErrorCode::InvalidCollateralValue);

        let feed = &mut ctx.accounts.price_feed;
        feed.price_lamports = price_lamports;
        feed.confidence_bps = confidence_bps;
        feed.timestamp = Clock::get()?.unix_timestamp;

        emit!(PriceUpdated {
            mint: feed.mint,
            price_lamports,
            confidence_bps,
            timestamp: feed.timestamp,
        });
        Ok(())
    }

    /// Emergency admin withdrawal — transfer wSOL directly from vault to authority.
    /// Only callable by the pool authority. Use this to recover funds that were
    /// deposited outside the share-based deposit flow.
    pub fn admin_withdraw(ctx: Context<AdminWithdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);

        let pool = &ctx.accounts.pool;
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
        position.shares = position
            .shares
            .checked_sub(shares)
            .ok_or(ErrorCode::MathOverflow)?;
        // Reduce deposited_amount proportionally
        let deposit_reduction = shares
            .checked_mul(position.deposited_amount)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(position.shares.checked_add(shares).unwrap())
            .unwrap_or(position.deposited_amount);
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
    /// `loan_option`       – tier 0/1/2.
    /// `collateral_value`  – oracle-supplied value in loan-token units.
    /// `loan_id`           – unique nonce (e.g. unix-ms).
    pub fn request_and_fund_loan(
        ctx: Context<RequestLoan>,
        collateral_amount: u64,
        loan_option: u8,
        collateral_value: u64,
        loan_id: u64,
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

        // --- Price attestation validation ---
        let feed = &ctx.accounts.price_feed;
        let now = Clock::get()?.unix_timestamp;

        // Price must be fresh (within MAX_PRICE_STALENESS seconds)
        require!(
            now.checked_sub(feed.timestamp).unwrap_or(i64::MAX) <= MAX_PRICE_STALENESS,
            ErrorCode::StalePriceAttestation
        );

        // Compute expected collateral value from attested price:
        // expected = collateral_amount * price_per_token / 10^decimals
        let decimals = ctx.accounts.collateral_mint.decimals;
        let expected_value = (collateral_amount as u128)
            .checked_mul(feed.price_lamports as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(10u128.pow(decimals as u32))
            .ok_or(ErrorCode::MathOverflow)?;

        // Submitted value cannot exceed attested value + tolerance
        let max_allowed = expected_value
            .checked_mul((BPS_DENOM as u128) + (MAX_VALUE_TOLERANCE_BPS as u128))
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOM as u128)
            .ok_or(ErrorCode::MathOverflow)?;

        require!(
            (collateral_value as u128) <= max_allowed,
            ErrorCode::CollateralValueExceedsAttestation
        );

        let tier = loan_option as usize;
        let ltv_bps = TIER_LTV_BPS[tier];
        let fee_bps = TIER_FEE_BPS[tier];
        let duration_days = TIER_DURATION_DAYS[tier];

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

            // pool_cut stays in the vault → depositors earn it automatically
            // through share appreciation (pool value unchanged while tokens stay)

            let pool = &mut ctx.accounts.pool;
            pool.total_fees_earned = pool
                .total_fees_earned
                .checked_add(fee)
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
        loan.start_timestamp = now;
        loan.due_timestamp = now
            .checked_add(duration_days.checked_mul(SECONDS_PER_DAY).unwrap())
            .ok_or(ErrorCode::MathOverflow)?;
        loan.status = LoanStatus::Active;
        loan.collateral_value_at_start = collateral_value;
        loan.bump = ctx.bumps.loan;
        loan.vault_bump = ctx.bumps.collateral_vault;

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

        // Return collateral to borrower (Token or Token-2022)
        let loan_key = ctx.accounts.loan.key();
        let vault_seeds = &[
            b"collateral-vault".as_ref(),
            loan_key.as_ref(),
            &[loan.vault_bump],
        ];
        let collateral_decimals = ctx.accounts.collateral_mint.decimals;
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
            loan.collateral_amount,
            collateral_decimals,
        )?;

        // Update loan
        let loan = &mut ctx.accounts.loan;
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

        let tier = match loan.ltv_bps {
            3_000 => 0usize,
            2_500 => 1,
            2_000 => 2,
            _ => return Err(ErrorCode::InvalidLoanOption.into()),
        };

        let fee_bps = TIER_FEE_BPS[tier];
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
        let extension = TIER_DURATION_DAYS[tier]
            .checked_mul(SECONDS_PER_DAY)
            .unwrap();
        loan.due_timestamp = loan
            .due_timestamp
            .checked_add(extension)
            .ok_or(ErrorCode::MathOverflow)?;
        let new_due = loan.due_timestamp;

        let pool = &mut ctx.accounts.pool;
        pool.total_fees_earned = pool
            .total_fees_earned
            .checked_add(extension_fee)
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
        space = 8 + PriceAttestation::INIT_SPACE,
        seeds = [b"price", mint.key().as_ref(), pool.key().as_ref()],
        bump,
    )]
    pub price_feed: Account<'info, PriceAttestation>,

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
        seeds = [b"price", price_feed.mint.as_ref(), pool.key().as_ref()],
        bump = price_feed.bump,
        constraint = price_feed.authority == authority.key() @ ErrorCode::Unauthorized,
    )]
    pub price_feed: Account<'info, PriceAttestation>,

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
#[instruction(collateral_amount: u64, loan_option: u8, collateral_value: u64, loan_id: u64)]
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
        seeds = [b"price", collateral_mint.key().as_ref(), pool.key().as_ref()],
        bump = price_feed.bump,
    )]
    pub price_feed: Box<Account<'info, PriceAttestation>>,

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

#[account]
#[derive(InitSpace)]
pub struct PriceAttestation {
    /// Token mint this attestation covers
    pub mint: Pubkey,
    /// Pool this attestation belongs to
    pub pool: Pubkey,
    /// Authority allowed to update this feed
    pub authority: Pubkey,
    /// Price of 1 full token in lamports (e.g. 1 token = 50000 lamports)
    pub price_lamports: u64,
    /// Unix timestamp of last update
    pub timestamp: i64,
    /// Confidence interval in basis points (informational)
    pub confidence_bps: u16,
    /// PDA bump
    pub bump: u8,
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
    /// LTV in basis points (2000, 2500, or 3000)
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
}
