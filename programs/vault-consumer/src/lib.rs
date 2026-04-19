use anchor_lang::prelude::*;

use agent_vault::cpi::accounts::AgentSpend;
use agent_vault::cpi::agent_spend;
use agent_vault::program::AgentVault;

declare_id!("4m4NB1tRKvWE6okuvU1Sf7HQLc6VWGrUpwFoc6ZZU4nX");

/// Task Escrow — a CPI consumer that demonstrates composability with Agent Vault.
///
/// Workflow:
///   1. A creator posts a task with a description and reward amount.
///   2. When the task is completed, `execute_and_pay` marks it done and
///      CPI-calls `agent_vault::agent_spend` to pay the reward from the
///      agent's vault to the designated destination.
///
/// This proves that any on-chain program can orchestrate autonomous agent
/// payments through the Agent Vault protocol.
#[program]
pub mod vault_consumer {
    use super::*;

    /// Create a new task with a description and reward amount.
    ///
    /// Seeds: [b"task", creator, description_hash]
    /// The description is hashed so seeds stay under the 32-byte limit.
    pub fn create_task(
        ctx: Context<CreateTask>,
        description: String,
        reward: u64,
    ) -> Result<()> {
        require!(reward > 0, TaskError::ZeroReward);
        require!(!description.is_empty(), TaskError::EmptyDescription);
        require!(description.len() <= 280, TaskError::DescriptionTooLong);

        let task = &mut ctx.accounts.task;
        task.creator = ctx.accounts.creator.key();
        task.description = description;
        task.reward = reward;
        task.completed = false;
        task.bump = ctx.bumps.task;

        Ok(())
    }

    /// Complete the task and pay the reward via CPI into Agent Vault.
    ///
    /// The agent signs this transaction, which authorizes the CPI spend.
    /// The vault program enforces all policy checks (limits, session, etc.).
    pub fn execute_and_pay(ctx: Context<ExecuteAndPay>) -> Result<()> {
        let task = &mut ctx.accounts.task;
        require!(!task.completed, TaskError::AlreadyCompleted);

        // Mark task as completed
        task.completed = true;

        // CPI into Agent Vault — agent_spend transfers SOL from the vault
        // to the destination address, subject to all vault policies.
        let cpi_program = ctx.accounts.vault_program.to_account_info();
        let cpi_accounts = AgentSpend {
            vault: ctx.accounts.vault.to_account_info(),
            agent: ctx.accounts.agent.to_account_info(),
            destination: ctx.accounts.destination.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

        agent_spend(cpi_ctx, task.reward)?;

        Ok(())
    }
}

// ── Accounts ─────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(description: String, reward: u64)]
pub struct CreateTask<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + Task::SPACE,
        seeds = [
            b"task",
            creator.key().as_ref(),
            &anchor_lang::solana_program::hash::hash(description.as_bytes()).to_bytes()[..8],
        ],
        bump,
    )]
    pub task: Account<'info, Task>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteAndPay<'info> {
    #[account(
        mut,
        has_one = creator @ TaskError::Unauthorized,
    )]
    pub task: Account<'info, Task>,

    /// The task creator must authorize execution.
    pub creator: Signer<'info>,

    /// The Agent Vault account — mutable because agent_spend debits it.
    /// CHECK: Validated by the Agent Vault program during CPI.
    #[account(mut)]
    pub vault: AccountInfo<'info>,

    /// The agent keypair — must be a signer so the vault program accepts the spend.
    pub agent: Signer<'info>,

    /// CHECK: Destination for the reward payment — can be any account.
    #[account(mut)]
    pub destination: AccountInfo<'info>,

    /// The Agent Vault program to CPI into.
    pub vault_program: Program<'info, AgentVault>,
}

// ── State ────────────────────────────────────────────────────────────────────

#[account]
pub struct Task {
    /// Who created this task.
    pub creator: Pubkey,
    /// Human-readable task description (max 280 chars).
    pub description: String,
    /// Reward in lamports to pay on completion.
    pub reward: u64,
    /// Whether the task has been completed and paid.
    pub completed: bool,
    /// PDA bump seed.
    pub bump: u8,
}

impl Task {
    // 32 (creator) + 4 + 280 (description String) + 8 (reward) + 1 (completed) + 1 (bump)
    pub const SPACE: usize = 32 + (4 + 280) + 8 + 1 + 1;
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum TaskError {
    #[msg("Reward must be greater than zero")]
    ZeroReward,
    #[msg("Description cannot be empty")]
    EmptyDescription,
    #[msg("Description must be 280 characters or fewer")]
    DescriptionTooLong,
    #[msg("Task has already been completed")]
    AlreadyCompleted,
    #[msg("Only the task creator can perform this action")]
    Unauthorized,
}
