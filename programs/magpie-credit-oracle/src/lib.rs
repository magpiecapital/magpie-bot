use anchor_lang::prelude::*;

declare_id!("BBYtty9sqWjHzTuoXSNfDCpNtLn6ZjfSfhYEoY6MFP2E");

/// Magpie Credit Oracle — On-chain composable credit primitive.
///
/// Stores per-wallet credit scores (300-850) that any Solana program can read
/// via CPI. Only the protocol authority can update scores; anyone can read.
#[program]
pub mod magpie_credit_oracle {
    use super::*;

    /// Initialize a new credit score account for a wallet.
    pub fn initialize_score(
        ctx: Context<InitializeScore>,
        wallet: Pubkey,
    ) -> Result<()> {
        let score_account = &mut ctx.accounts.score_account;
        score_account.wallet = wallet;
        score_account.authority = ctx.accounts.authority.key();
        score_account.score = 300; // starting score
        score_account.tier = CreditTier::Bronze;
        score_account.f_repayment_history = 0;
        score_account.f_loan_volume = 0;
        score_account.f_account_age = 0;
        score_account.f_collateral_diversity = 0;
        score_account.f_liquidation_ratio = 100; // perfect until proven otherwise
        score_account.f_protocol_engagement = 0;
        score_account.max_ltv_bps = 3000; // 30%
        score_account.fee_rate_bps = 150; // 1.5%
        score_account.max_duration_days = 7;
        score_account.loans_scored = 0;
        score_account.last_updated = Clock::get()?.unix_timestamp;
        score_account.bump = ctx.bumps.score_account;

        emit!(CreditScoreInitialized {
            wallet,
            authority: ctx.accounts.authority.key(),
            timestamp: score_account.last_updated,
        });

        Ok(())
    }

    /// Update a wallet's credit score. Only callable by the protocol authority.
    pub fn update_score(
        ctx: Context<UpdateScore>,
        new_score: u16,
        factors: ScoreFactors,
    ) -> Result<()> {
        require!(new_score >= 300 && new_score <= 850, ErrorCode::ScoreOutOfRange);

        let score_account = &mut ctx.accounts.score_account;
        let old_score = score_account.score;

        score_account.score = new_score;
        score_account.tier = CreditTier::from_score(new_score);
        score_account.f_repayment_history = factors.repayment_history;
        score_account.f_loan_volume = factors.loan_volume;
        score_account.f_account_age = factors.account_age;
        score_account.f_collateral_diversity = factors.collateral_diversity;
        score_account.f_liquidation_ratio = factors.liquidation_ratio;
        score_account.f_protocol_engagement = factors.protocol_engagement;
        score_account.loans_scored = factors.loans_scored;

        // Update tier benefits
        let benefits = score_account.tier.benefits();
        score_account.max_ltv_bps = benefits.max_ltv_bps;
        score_account.fee_rate_bps = benefits.fee_rate_bps;
        score_account.max_duration_days = benefits.max_duration_days;

        score_account.last_updated = Clock::get()?.unix_timestamp;

        emit!(CreditScoreUpdated {
            wallet: score_account.wallet,
            old_score,
            new_score,
            tier: score_account.tier,
            timestamp: score_account.last_updated,
        });

        Ok(())
    }

    /// Transfer authority to a new address. Only callable by current authority.
    pub fn transfer_authority(
        ctx: Context<TransferAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        let score_account = &mut ctx.accounts.score_account;
        let old = score_account.authority;
        score_account.authority = new_authority;

        emit!(AuthorityTransferred {
            wallet: score_account.wallet,
            old_authority: old,
            new_authority,
        });

        Ok(())
    }
}

// ─── Accounts ───────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct InitializeScore<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + CreditScoreAccount::INIT_SPACE,
        seeds = [b"credit-score", wallet.as_ref()],
        bump,
    )]
    pub score_account: Account<'info, CreditScoreAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateScore<'info> {
    #[account(
        mut,
        has_one = authority @ ErrorCode::Unauthorized,
    )]
    pub score_account: Account<'info, CreditScoreAccount>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct TransferAuthority<'info> {
    #[account(
        mut,
        has_one = authority @ ErrorCode::Unauthorized,
    )]
    pub score_account: Account<'info, CreditScoreAccount>,
    pub authority: Signer<'info>,
}

// ─── State ──────────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct CreditScoreAccount {
    /// The Solana wallet this score belongs to.
    pub wallet: Pubkey,           // 32
    /// Authority that can update this score (protocol signer).
    pub authority: Pubkey,        // 32
    /// Credit score: 300-850.
    pub score: u16,               // 2
    /// Credit tier derived from score.
    pub tier: CreditTier,         // 1
    /// Factor scores (0-100 each).
    pub f_repayment_history: u8,  // 1
    pub f_loan_volume: u8,        // 1
    pub f_account_age: u8,        // 1
    pub f_collateral_diversity: u8, // 1
    pub f_liquidation_ratio: u8,  // 1
    pub f_protocol_engagement: u8, // 1
    /// Tier benefits (computed from score).
    pub max_ltv_bps: u16,         // 2 (basis points, e.g. 3500 = 35%)
    pub fee_rate_bps: u16,        // 2 (basis points, e.g. 150 = 1.5%)
    pub max_duration_days: u8,    // 1
    /// Number of loans that contributed to this score.
    pub loans_scored: u32,        // 4
    /// Unix timestamp of last update.
    pub last_updated: i64,        // 8
    /// PDA bump.
    pub bump: u8,                 // 1
}

// ─── Enums ──────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum CreditTier {
    Bronze,    // 300-499
    Silver,    // 500-649
    Gold,      // 650-749
    Platinum,  // 750-850
}

impl CreditTier {
    pub fn from_score(score: u16) -> Self {
        match score {
            750..=850 => CreditTier::Platinum,
            650..=749 => CreditTier::Gold,
            500..=649 => CreditTier::Silver,
            _ => CreditTier::Bronze,
        }
    }

    pub fn benefits(&self) -> TierBenefits {
        match self {
            CreditTier::Bronze => TierBenefits { max_ltv_bps: 3000, fee_rate_bps: 150, max_duration_days: 7 },
            CreditTier::Silver => TierBenefits { max_ltv_bps: 3200, fee_rate_bps: 150, max_duration_days: 7 },
            CreditTier::Gold => TierBenefits { max_ltv_bps: 3500, fee_rate_bps: 125, max_duration_days: 14 },
            CreditTier::Platinum => TierBenefits { max_ltv_bps: 3800, fee_rate_bps: 100, max_duration_days: 30 },
        }
    }
}

pub struct TierBenefits {
    pub max_ltv_bps: u16,
    pub fee_rate_bps: u16,
    pub max_duration_days: u8,
}

// ─── Instruction args ───────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoreFactors {
    pub repayment_history: u8,
    pub loan_volume: u8,
    pub account_age: u8,
    pub collateral_diversity: u8,
    pub liquidation_ratio: u8,
    pub protocol_engagement: u8,
    pub loans_scored: u32,
}

// ─── Events ─────────────────────────────────────────────────────────────────

#[event]
pub struct CreditScoreInitialized {
    pub wallet: Pubkey,
    pub authority: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct CreditScoreUpdated {
    pub wallet: Pubkey,
    pub old_score: u16,
    pub new_score: u16,
    pub tier: CreditTier,
    pub timestamp: i64,
}

#[event]
pub struct AuthorityTransferred {
    pub wallet: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

// ─── Errors ─────────────────────────────────────────────────────────────────

#[error_code]
pub enum ErrorCode {
    #[msg("Score must be between 300 and 850")]
    ScoreOutOfRange,
    #[msg("Only the authority can perform this action")]
    Unauthorized,
}
