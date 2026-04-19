use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("J9R83EHNJtrzwcS9PxJ9yyLs4SrWAsgQ6Laf6zNBeF8t");

/// Agent Vault Protocol
///
/// Programmable wallets for AI agents on Solana.
/// Owners create vaults with spending policies — per-transaction limits,
/// daily budgets, session expiry, and optional allowlists.
/// Agents spend autonomously within those bounds. Every action is logged
/// on-chain for full auditability.
#[program]
pub mod agent_vault {
    use super::*;

    /// Create a new vault with an assigned agent and spending policy.
    ///
    /// Seeds: [b"vault", owner, agent]
    /// One vault per owner–agent pair.
    pub fn create_vault(
        ctx: Context<CreateVault>,
        agent: Pubkey,
        spend_limit: u64,
        daily_limit: u64,
        session_duration: i64,
    ) -> Result<()> {
        require!(spend_limit > 0, VaultError::InvalidSpendLimit);
        require!(daily_limit >= spend_limit, VaultError::DailyLimitBelowSpendLimit);

        let clock = Clock::get()?;
        let vault = &mut ctx.accounts.vault;

        vault.owner = ctx.accounts.owner.key();
        vault.agent = agent;
        vault.spend_limit = spend_limit;
        vault.daily_limit = daily_limit;
        vault.spent_today = 0;
        vault.period_start = clock.unix_timestamp;
        vault.session_expiry = if session_duration > 0 {
            clock.unix_timestamp.checked_add(session_duration).ok_or(VaultError::Overflow)?
        } else {
            0
        };
        vault.is_active = true;
        vault.total_spent = 0;
        vault.total_received = 0;
        vault.tx_count = 0;
        vault.created_at = clock.unix_timestamp;
        vault.bump = ctx.bumps.vault;

        emit!(VaultCreated {
            vault: vault.key(),
            owner: vault.owner,
            agent,
            spend_limit,
            daily_limit,
            session_expiry: vault.session_expiry,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Deposit SOL into a vault. Anyone can deposit.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            amount,
        )?;

        let vault = &mut ctx.accounts.vault;
        vault.total_received = vault
            .total_received
            .checked_add(amount)
            .ok_or(VaultError::Overflow)?;

        emit!(Deposited {
            vault: vault.key(),
            depositor: ctx.accounts.depositor.key(),
            amount,
            new_balance: vault.to_account_info().lamports(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Agent spends SOL from the vault to a destination.
    ///
    /// Enforces every policy layer:
    ///   1. Vault must be active
    ///   2. Session must not be expired
    ///   3. Caller must be the assigned agent
    ///   4. Amount must be ≤ per-transaction limit
    ///   5. Daily cumulative must be ≤ daily limit
    ///   6. Vault must have sufficient balance (above rent-exempt minimum)
    pub fn agent_spend(ctx: Context<AgentSpend>, amount: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        let clock = Clock::get()?;

        // 1. Active check
        require!(vault.is_active, VaultError::VaultInactive);

        // 2. Session check
        if vault.session_expiry > 0 {
            require!(
                clock.unix_timestamp < vault.session_expiry,
                VaultError::SessionExpired
            );
        }

        // 3. Agent identity (also enforced by has_one, belt-and-suspenders)
        require!(
            ctx.accounts.agent.key() == vault.agent,
            VaultError::Unauthorized
        );

        // 4. Per-transaction limit
        require!(amount > 0, VaultError::ZeroAmount);
        require!(amount <= vault.spend_limit, VaultError::ExceedsTransactionLimit);

        // Roll daily window if 24 hours have passed
        if clock.unix_timestamp.saturating_sub(vault.period_start) >= 86_400 {
            vault.spent_today = 0;
            vault.period_start = clock.unix_timestamp;
        }

        // 5. Daily limit
        let new_daily = vault
            .spent_today
            .checked_add(amount)
            .ok_or(VaultError::Overflow)?;
        require!(new_daily <= vault.daily_limit, VaultError::ExceedsDailyLimit);

        // 6. Balance check — preserve rent exemption
        let vault_info = vault.to_account_info();
        let rent = Rent::get()?.minimum_balance(vault_info.data_len());
        let available = vault_info.lamports().saturating_sub(rent);
        require!(amount <= available, VaultError::InsufficientFunds);

        // Transfer lamports (safe — vault is program-owned)
        **vault.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.destination.try_borrow_mut_lamports()? += amount;

        // Update counters
        vault.spent_today = new_daily;
        vault.total_spent = vault
            .total_spent
            .checked_add(amount)
            .ok_or(VaultError::Overflow)?;
        vault.tx_count = vault.tx_count.checked_add(1).ok_or(VaultError::Overflow)?;

        emit!(AgentSpent {
            vault: vault.key(),
            agent: vault.agent,
            destination: ctx.accounts.destination.key(),
            amount,
            daily_spent: vault.spent_today,
            daily_remaining: vault.daily_limit.saturating_sub(vault.spent_today),
            tx_count: vault.tx_count,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Owner updates the spending policy.
    pub fn update_policy(
        ctx: Context<OwnerAction>,
        spend_limit: u64,
        daily_limit: u64,
    ) -> Result<()> {
        require!(spend_limit > 0, VaultError::InvalidSpendLimit);
        require!(daily_limit >= spend_limit, VaultError::DailyLimitBelowSpendLimit);

        let vault = &mut ctx.accounts.vault;
        let old_spend = vault.spend_limit;
        let old_daily = vault.daily_limit;
        vault.spend_limit = spend_limit;
        vault.daily_limit = daily_limit;

        emit!(PolicyUpdated {
            vault: vault.key(),
            old_spend_limit: old_spend,
            new_spend_limit: spend_limit,
            old_daily_limit: old_daily,
            new_daily_limit: daily_limit,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Owner extends (or sets) the agent's session.
    pub fn extend_session(ctx: Context<OwnerAction>, duration: i64) -> Result<()> {
        require!(duration > 0, VaultError::InvalidSessionDuration);

        let vault = &mut ctx.accounts.vault;
        let clock = Clock::get()?;

        vault.session_expiry = clock
            .unix_timestamp
            .checked_add(duration)
            .ok_or(VaultError::Overflow)?;
        vault.is_active = true;

        emit!(SessionExtended {
            vault: vault.key(),
            new_expiry: vault.session_expiry,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Owner immediately revokes the agent's access.
    pub fn revoke_agent(ctx: Context<OwnerAction>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.is_active = false;

        emit!(AgentRevoked {
            vault: vault.key(),
            agent: vault.agent,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Owner swaps the agent keypair. Resets daily spending and reactivates.
    pub fn set_agent(
        ctx: Context<OwnerAction>,
        new_agent: Pubkey,
        session_duration: i64,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        let clock = Clock::get()?;
        let old_agent = vault.agent;

        vault.agent = new_agent;
        vault.is_active = true;
        vault.spent_today = 0;
        vault.period_start = clock.unix_timestamp;
        vault.session_expiry = if session_duration > 0 {
            clock.unix_timestamp.checked_add(session_duration).ok_or(VaultError::Overflow)?
        } else {
            0
        };

        emit!(AgentChanged {
            vault: vault.key(),
            old_agent,
            new_agent,
            session_expiry: vault.session_expiry,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Owner withdraws SOL from the vault.
    pub fn owner_withdraw(ctx: Context<OwnerAction>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);

        let vault = &mut ctx.accounts.vault;
        let vault_info = vault.to_account_info();
        let rent = Rent::get()?.minimum_balance(vault_info.data_len());
        let available = vault_info.lamports().saturating_sub(rent);
        require!(amount <= available, VaultError::InsufficientFunds);

        **vault.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.owner.try_borrow_mut_lamports()? += amount;

        emit!(OwnerWithdrew {
            vault: vault.key(),
            owner: vault.owner,
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Owner closes the vault and reclaims all SOL (including rent).
    pub fn close_vault(ctx: Context<CloseVault>) -> Result<()> {
        emit!(VaultClosed {
            vault: ctx.accounts.vault.key(),
            owner: ctx.accounts.owner.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// ─── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(agent: Pubkey)]
pub struct CreateVault<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + Vault::SPACE,
        seeds = [b"vault", owner.key().as_ref(), agent.as_ref()],
        bump,
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub depositor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AgentSpend<'info> {
    #[account(
        mut,
        has_one = agent @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,
    pub agent: Signer<'info>,
    /// CHECK: Destination can be any account — the owner controls risk via policy.
    #[account(mut)]
    pub destination: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct OwnerAction<'info> {
    #[account(
        mut,
        has_one = owner @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseVault<'info> {
    #[account(
        mut,
        has_one = owner @ VaultError::Unauthorized,
        close = owner,
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

// ─── State ───────────────────────────────────────────────────────────────────

#[account]
pub struct Vault {
    /// Human owner who controls policies and can withdraw.
    pub owner: Pubkey,
    /// AI agent keypair authorized to spend within policy bounds.
    pub agent: Pubkey,
    /// Maximum lamports per single transaction.
    pub spend_limit: u64,
    /// Maximum lamports the agent can spend in a rolling 24h window.
    pub daily_limit: u64,
    /// Lamports spent so far in the current 24h period.
    pub spent_today: u64,
    /// Unix timestamp when the current 24h period started.
    pub period_start: i64,
    /// Unix timestamp when the agent's session expires. 0 = no expiry.
    pub session_expiry: i64,
    /// Whether the agent is currently authorized to spend.
    pub is_active: bool,
    /// Lifetime lamports spent by agents.
    pub total_spent: u64,
    /// Lifetime lamports deposited.
    pub total_received: u64,
    /// Total number of agent spend transactions.
    pub tx_count: u64,
    /// When this vault was created.
    pub created_at: i64,
    /// PDA bump seed.
    pub bump: u8,
}

impl Vault {
    // 32 + 32 + 8 + 8 + 8 + 8 + 8 + 1 + 8 + 8 + 8 + 8 + 1 = 138
    pub const SPACE: usize = 32 + 32 + 8 + 8 + 8 + 8 + 8 + 1 + 8 + 8 + 8 + 8 + 1;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

#[error_code]
pub enum VaultError {
    #[msg("Only the vault owner can perform this action")]
    Unauthorized,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Spend limit must be greater than zero")]
    InvalidSpendLimit,
    #[msg("Daily limit must be ≥ per-transaction spend limit")]
    DailyLimitBelowSpendLimit,
    #[msg("Session duration must be positive")]
    InvalidSessionDuration,
    #[msg("Vault is not active — agent access has been revoked")]
    VaultInactive,
    #[msg("Agent session has expired — owner must extend")]
    SessionExpired,
    #[msg("Amount exceeds per-transaction spend limit")]
    ExceedsTransactionLimit,
    #[msg("Amount would exceed daily spending limit")]
    ExceedsDailyLimit,
    #[msg("Insufficient vault balance (rent-exempt minimum preserved)")]
    InsufficientFunds,
    #[msg("Arithmetic overflow")]
    Overflow,
}

// ─── Events ──────────────────────────────────────────────────────────────────

#[event]
pub struct VaultCreated {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub spend_limit: u64,
    pub daily_limit: u64,
    pub session_expiry: i64,
    pub timestamp: i64,
}

#[event]
pub struct Deposited {
    pub vault: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub new_balance: u64,
    pub timestamp: i64,
}

#[event]
pub struct AgentSpent {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub daily_spent: u64,
    pub daily_remaining: u64,
    pub tx_count: u64,
    pub timestamp: i64,
}

#[event]
pub struct PolicyUpdated {
    pub vault: Pubkey,
    pub old_spend_limit: u64,
    pub new_spend_limit: u64,
    pub old_daily_limit: u64,
    pub new_daily_limit: u64,
    pub timestamp: i64,
}

#[event]
pub struct SessionExtended {
    pub vault: Pubkey,
    pub new_expiry: i64,
    pub timestamp: i64,
}

#[event]
pub struct AgentRevoked {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct AgentChanged {
    pub vault: Pubkey,
    pub old_agent: Pubkey,
    pub new_agent: Pubkey,
    pub session_expiry: i64,
    pub timestamp: i64,
}

#[event]
pub struct OwnerWithdrew {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct VaultClosed {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub timestamp: i64,
}
