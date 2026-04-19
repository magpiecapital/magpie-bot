/**
 * @magpiecapital/agent-vault-sdk
 *
 * Programmable wallets for AI agents on Solana.
 *
 * Owner side — create vaults, set policies, fund agents:
 * ```typescript
 * const vault = new AgentVaultOwner(connection, ownerKeypair);
 * const vaultAddr = await vault.create(agentPubkey, {
 *   spendLimit: 0.1 * LAMPORTS_PER_SOL,   // 0.1 SOL per tx
 *   dailyLimit: 1 * LAMPORTS_PER_SOL,      // 1 SOL per day
 *   sessionDuration: 86400,                 // 24 hours
 * });
 * await vault.deposit(vaultAddr, 2 * LAMPORTS_PER_SOL);
 * ```
 *
 * Agent side — spend from the vault within policy bounds:
 * ```typescript
 * const agent = new AgentVaultAgent(connection, agentKeypair);
 * await agent.spend(vaultAddr, destination, 0.05 * LAMPORTS_PER_SOL);
 * ```
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

// ─── Constants ───────────────────────────────────────────────────────────────

export const AGENT_VAULT_PROGRAM_ID = new PublicKey(
  "J9R83EHNJtrzwcS9PxJ9yyLs4SrWAsgQ6Laf6zNBeF8t",
);

export const VAULT_SEED = Buffer.from("vault");
export const TOKEN_VAULT_SEED = Buffer.from("token_vault");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VaultPolicy {
  /** Max lamports the agent can spend in a single transaction. */
  spendLimit: number;
  /** Max lamports the agent can spend in a rolling 24-hour window. */
  dailyLimit: number;
  /** Session duration in seconds. 0 = no expiry. */
  sessionDuration: number;
}

export interface VaultState {
  address: PublicKey;
  owner: PublicKey;
  agent: PublicKey;
  spendLimit: number;
  dailyLimit: number;
  spentToday: number;
  periodStart: number;
  sessionExpiry: number;
  isActive: boolean;
  totalSpent: number;
  totalReceived: number;
  txCount: number;
  createdAt: number;
  bump: number;
  /** SOL balance available for agent spending (excludes rent). */
  availableBalance: number;
}

export interface TokenVaultPolicy {
  /** Max tokens (smallest unit) the agent can spend in a single transaction. */
  spendLimit: number;
  /** Max tokens (smallest unit) the agent can spend in a rolling 24-hour window. */
  dailyLimit: number;
  /** Session duration in seconds. 0 = no expiry. */
  sessionDuration: number;
}

export interface TokenVaultState {
  address: PublicKey;
  owner: PublicKey;
  agent: PublicKey;
  mint: PublicKey;
  tokenAccount: PublicKey;
  spendLimit: number;
  dailyLimit: number;
  spentToday: number;
  periodStart: number;
  sessionExpiry: number;
  isActive: boolean;
  totalSpent: number;
  totalReceived: number;
  txCount: number;
  createdAt: number;
  bump: number;
  /** Token balance available in the vault. */
  tokenBalance: number;
}

// ─── PDA derivation ──────────────────────────────────────────────────────────

/**
 * Derive the vault PDA for an owner–agent pair.
 */
export function deriveVaultPDA(
  owner: PublicKey,
  agent: PublicKey,
  programId: PublicKey = AGENT_VAULT_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, owner.toBuffer(), agent.toBuffer()],
    programId,
  );
}

/**
 * Derive the token vault PDA for an owner–agent–mint triple.
 */
export function deriveTokenVaultPDA(
  owner: PublicKey,
  agent: PublicKey,
  mint: PublicKey,
  programId: PublicKey = AGENT_VAULT_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [TOKEN_VAULT_SEED, owner.toBuffer(), agent.toBuffer(), mint.toBuffer()],
    programId,
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getProgram(connection: Connection, signer: Keypair): Program {
  const idl = require("../../../src/solana/idl/agent-vault.json");
  const provider = new AnchorProvider(
    connection,
    new Wallet(signer),
    { commitment: "confirmed" },
  );
  return new Program(idl, provider);
}

function parseVaultAccount(raw: any, address: PublicKey, lamports: number, dataLen: number): VaultState {
  // Rent-exempt minimum for the vault account
  const rentExempt = Math.ceil(dataLen * 6.96 + 128) * 2; // approximate
  return {
    address,
    owner: raw.owner,
    agent: raw.agent,
    spendLimit: Number(raw.spendLimit),
    dailyLimit: Number(raw.dailyLimit),
    spentToday: Number(raw.spentToday),
    periodStart: Number(raw.periodStart),
    sessionExpiry: Number(raw.sessionExpiry),
    isActive: raw.isActive,
    totalSpent: Number(raw.totalSpent),
    totalReceived: Number(raw.totalReceived),
    txCount: Number(raw.txCount),
    createdAt: Number(raw.createdAt),
    bump: raw.bump,
    availableBalance: Math.max(0, lamports - rentExempt),
  };
}

// ─── Owner SDK ───────────────────────────────────────────────────────────────

/**
 * Owner-side interface for creating and managing agent vaults.
 */
export class AgentVaultOwner {
  private connection: Connection;
  private owner: Keypair;
  private programId: PublicKey;

  constructor(
    connection: Connection,
    owner: Keypair,
    programId: PublicKey = AGENT_VAULT_PROGRAM_ID,
  ) {
    this.connection = connection;
    this.owner = owner;
    this.programId = programId;
  }

  /**
   * Create a new vault for an AI agent.
   * Returns the vault PDA address.
   */
  async create(agent: PublicKey, policy: VaultPolicy): Promise<PublicKey> {
    const program = getProgram(this.connection, this.owner);
    const [vaultPda] = deriveVaultPDA(this.owner.publicKey, agent, this.programId);

    await program.methods
      .createVault(
        agent,
        new BN(policy.spendLimit),
        new BN(policy.dailyLimit),
        new BN(policy.sessionDuration),
      )
      .accounts({
        vault: vaultPda,
        owner: this.owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    return vaultPda;
  }

  /**
   * Deposit SOL into a vault.
   */
  async deposit(vault: PublicKey, lamports: number): Promise<string> {
    const program = getProgram(this.connection, this.owner);
    return program.methods
      .deposit(new BN(lamports))
      .accounts({
        vault,
        depositor: this.owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });
  }

  /**
   * Update the vault's spending policy.
   */
  async updatePolicy(vault: PublicKey, spendLimit: number, dailyLimit: number): Promise<string> {
    const program = getProgram(this.connection, this.owner);
    return program.methods
      .updatePolicy(new BN(spendLimit), new BN(dailyLimit))
      .accounts({ vault, owner: this.owner.publicKey })
      .rpc({ commitment: "confirmed" });
  }

  /**
   * Extend the agent's session.
   */
  async extendSession(vault: PublicKey, durationSeconds: number): Promise<string> {
    const program = getProgram(this.connection, this.owner);
    return program.methods
      .extendSession(new BN(durationSeconds))
      .accounts({ vault, owner: this.owner.publicKey })
      .rpc({ commitment: "confirmed" });
  }

  /**
   * Revoke the agent's spending authority immediately.
   */
  async revokeAgent(vault: PublicKey): Promise<string> {
    const program = getProgram(this.connection, this.owner);
    return program.methods
      .revokeAgent()
      .accounts({ vault, owner: this.owner.publicKey })
      .rpc({ commitment: "confirmed" });
  }

  /**
   * Assign a new agent to the vault.
   */
  async setAgent(
    vault: PublicKey,
    newAgent: PublicKey,
    sessionDuration: number,
  ): Promise<string> {
    const program = getProgram(this.connection, this.owner);
    return program.methods
      .setAgent(newAgent, new BN(sessionDuration))
      .accounts({ vault, owner: this.owner.publicKey })
      .rpc({ commitment: "confirmed" });
  }

  /**
   * Withdraw SOL from the vault back to the owner.
   */
  async withdraw(vault: PublicKey, lamports: number): Promise<string> {
    const program = getProgram(this.connection, this.owner);
    return program.methods
      .ownerWithdraw(new BN(lamports))
      .accounts({ vault, owner: this.owner.publicKey })
      .rpc({ commitment: "confirmed" });
  }

  /**
   * Close the vault and reclaim all SOL.
   */
  async close(vault: PublicKey): Promise<string> {
    const program = getProgram(this.connection, this.owner);
    return program.methods
      .closeVault()
      .accounts({ vault, owner: this.owner.publicKey })
      .rpc({ commitment: "confirmed" });
  }

  // ─── Token Vault Methods ──────────────────────────────────────────────────

  /**
   * Create a new token vault for an AI agent with a specific SPL mint.
   * Returns the token vault PDA address.
   */
  async createTokenVault(
    agent: PublicKey,
    mint: PublicKey,
    policy: TokenVaultPolicy,
  ): Promise<PublicKey> {
    const program = getProgram(this.connection, this.owner);
    const [tokenVaultPda] = deriveTokenVaultPDA(
      this.owner.publicKey, agent, mint, this.programId,
    );
    const vaultTokenAccount = getAssociatedTokenAddressSync(
      mint, tokenVaultPda, true,
    );

    await program.methods
      .createTokenVault(
        agent,
        new BN(policy.spendLimit),
        new BN(policy.dailyLimit),
        new BN(policy.sessionDuration),
      )
      .accounts({
        tokenVault: tokenVaultPda,
        vaultTokenAccount,
        mint,
        owner: this.owner.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    return tokenVaultPda;
  }

  /**
   * Deposit SPL tokens into a token vault.
   */
  async depositToken(
    tokenVault: PublicKey,
    mint: PublicKey,
    amount: number,
  ): Promise<string> {
    const program = getProgram(this.connection, this.owner);
    const vaultTokenAccount = getAssociatedTokenAddressSync(
      mint, tokenVault, true,
    );
    const depositorTokenAccount = getAssociatedTokenAddressSync(
      mint, this.owner.publicKey,
    );

    return program.methods
      .depositToken(new BN(amount))
      .accounts({
        tokenVault,
        vaultTokenAccount,
        depositorTokenAccount,
        mint,
        depositor: this.owner.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });
  }

  /**
   * Update token vault spending policy.
   */
  async updateTokenPolicy(
    tokenVault: PublicKey,
    spendLimit: number,
    dailyLimit: number,
  ): Promise<string> {
    const program = getProgram(this.connection, this.owner);
    return program.methods
      .updateTokenPolicy(new BN(spendLimit), new BN(dailyLimit))
      .accounts({ tokenVault, owner: this.owner.publicKey })
      .rpc({ commitment: "confirmed" });
  }

  /**
   * Extend token vault session.
   */
  async extendTokenSession(
    tokenVault: PublicKey,
    durationSeconds: number,
  ): Promise<string> {
    const program = getProgram(this.connection, this.owner);
    return program.methods
      .extendTokenSession(new BN(durationSeconds))
      .accounts({ tokenVault, owner: this.owner.publicKey })
      .rpc({ commitment: "confirmed" });
  }

  /**
   * Revoke token vault agent.
   */
  async revokeTokenAgent(tokenVault: PublicKey): Promise<string> {
    const program = getProgram(this.connection, this.owner);
    return program.methods
      .revokeTokenAgent()
      .accounts({ tokenVault, owner: this.owner.publicKey })
      .rpc({ commitment: "confirmed" });
  }

  /**
   * Withdraw SPL tokens from a token vault back to the owner.
   */
  async withdrawToken(
    tokenVault: PublicKey,
    mint: PublicKey,
    amount: number,
  ): Promise<string> {
    const program = getProgram(this.connection, this.owner);
    const vaultTokenAccount = getAssociatedTokenAddressSync(
      mint, tokenVault, true,
    );
    const ownerTokenAccount = getAssociatedTokenAddressSync(
      mint, this.owner.publicKey,
    );

    return program.methods
      .ownerWithdrawToken(new BN(amount))
      .accounts({
        tokenVault,
        vaultTokenAccount,
        ownerTokenAccount,
        mint,
        owner: this.owner.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });
  }

  /**
   * Close a token vault — drains remaining tokens and reclaims rent.
   */
  async closeTokenVault(tokenVault: PublicKey, mint: PublicKey): Promise<string> {
    const program = getProgram(this.connection, this.owner);
    const vaultTokenAccount = getAssociatedTokenAddressSync(
      mint, tokenVault, true,
    );
    const ownerTokenAccount = getAssociatedTokenAddressSync(
      mint, this.owner.publicKey,
    );

    return program.methods
      .closeTokenVault()
      .accounts({
        tokenVault,
        vaultTokenAccount,
        ownerTokenAccount,
        mint,
        owner: this.owner.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });
  }
}

// ─── Agent SDK ───────────────────────────────────────────────────────────────

/**
 * Agent-side interface for spending from a vault.
 * This is what AI agents use to make autonomous payments.
 */
export class AgentVaultAgent {
  private connection: Connection;
  private agent: Keypair;
  private programId: PublicKey;

  constructor(
    connection: Connection,
    agent: Keypair,
    programId: PublicKey = AGENT_VAULT_PROGRAM_ID,
  ) {
    this.connection = connection;
    this.agent = agent;
    this.programId = programId;
  }

  /**
   * Spend SOL from the vault to a destination address.
   * The program enforces all policy checks on-chain.
   */
  async spend(vault: PublicKey, destination: PublicKey, lamports: number): Promise<string> {
    const program = getProgram(this.connection, this.agent);
    return program.methods
      .agentSpend(new BN(lamports))
      .accounts({
        vault,
        agent: this.agent.publicKey,
        destination,
      })
      .rpc({ commitment: "confirmed" });
  }

  /**
   * Spend SPL tokens from a token vault to a destination token account.
   * The program enforces all policy checks on-chain.
   */
  async spendToken(
    tokenVault: PublicKey,
    mint: PublicKey,
    destinationTokenAccount: PublicKey,
    amount: number,
  ): Promise<string> {
    const program = getProgram(this.connection, this.agent);
    const vaultTokenAccount = getAssociatedTokenAddressSync(
      mint, tokenVault, true,
    );

    return program.methods
      .agentSpendToken(new BN(amount))
      .accounts({
        tokenVault,
        vaultTokenAccount,
        destinationTokenAccount,
        mint,
        agent: this.agent.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });
  }

  /**
   * Get the vault address for this agent and a given owner.
   */
  getVaultAddress(owner: PublicKey): PublicKey {
    return deriveVaultPDA(owner, this.agent.publicKey, this.programId)[0];
  }

  /**
   * Get the token vault address for this agent, owner, and mint.
   */
  getTokenVaultAddress(owner: PublicKey, mint: PublicKey): PublicKey {
    return deriveTokenVaultPDA(owner, this.agent.publicKey, mint, this.programId)[0];
  }
}

// ─── Read-only SDK ───────────────────────────────────────────────────────────

/**
 * Read-only interface — no keypair needed.
 * For dashboards, explorers, and CPI integrations.
 */
export class AgentVaultReader {
  private connection: Connection;
  private programId: PublicKey;

  constructor(
    connection: Connection,
    programId: PublicKey = AGENT_VAULT_PROGRAM_ID,
  ) {
    this.connection = connection;
    this.programId = programId;
  }

  /**
   * Fetch the full state of a vault.
   */
  async getVault(address: PublicKey): Promise<VaultState | null> {
    const dummy = Keypair.generate();
    const program = getProgram(this.connection, dummy);

    try {
      const info = await this.connection.getAccountInfo(address);
      if (!info) return null;

      const raw = program.coder.accounts.decode("Vault", info.data);
      return parseVaultAccount(raw, address, info.lamports, info.data.length);
    } catch {
      return null;
    }
  }

  /**
   * Fetch the vault for a specific owner–agent pair.
   */
  async getVaultByPair(owner: PublicKey, agent: PublicKey): Promise<VaultState | null> {
    const [pda] = deriveVaultPDA(owner, agent, this.programId);
    return this.getVault(pda);
  }

  /**
   * Check if an agent's session is still valid.
   */
  async isSessionValid(vaultAddress: PublicKey): Promise<boolean> {
    const vault = await this.getVault(vaultAddress);
    if (!vault || !vault.isActive) return false;
    if (vault.sessionExpiry === 0) return true;
    return Date.now() / 1000 < vault.sessionExpiry;
  }

  /**
   * Get the remaining daily budget for an agent.
   */
  async getDailyRemaining(vaultAddress: PublicKey): Promise<number> {
    const vault = await this.getVault(vaultAddress);
    if (!vault) return 0;

    const now = Date.now() / 1000;
    // If 24h has passed, full daily budget is available
    if (now - vault.periodStart >= 86400) return vault.dailyLimit;
    return Math.max(0, vault.dailyLimit - vault.spentToday);
  }

  /**
   * Fetch the full state of a token vault.
   */
  async getTokenVault(address: PublicKey): Promise<TokenVaultState | null> {
    const dummy = Keypair.generate();
    const program = getProgram(this.connection, dummy);

    try {
      const info = await this.connection.getAccountInfo(address);
      if (!info) return null;

      const raw = program.coder.accounts.decode("TokenVault", info.data);

      // Fetch token balance from the vault's ATA
      let tokenBalance = 0;
      try {
        const ataInfo = await this.connection.getTokenAccountBalance(raw.tokenAccount);
        tokenBalance = Number(ataInfo.value.amount);
      } catch {
        // ATA may not exist yet
      }

      return {
        address,
        owner: raw.owner,
        agent: raw.agent,
        mint: raw.mint,
        tokenAccount: raw.tokenAccount,
        spendLimit: Number(raw.spendLimit),
        dailyLimit: Number(raw.dailyLimit),
        spentToday: Number(raw.spentToday),
        periodStart: Number(raw.periodStart),
        sessionExpiry: Number(raw.sessionExpiry),
        isActive: raw.isActive,
        totalSpent: Number(raw.totalSpent),
        totalReceived: Number(raw.totalReceived),
        txCount: Number(raw.txCount),
        createdAt: Number(raw.createdAt),
        bump: raw.bump,
        tokenBalance,
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch a token vault for a specific owner–agent–mint triple.
   */
  async getTokenVaultByTriple(
    owner: PublicKey,
    agent: PublicKey,
    mint: PublicKey,
  ): Promise<TokenVaultState | null> {
    const [pda] = deriveTokenVaultPDA(owner, agent, mint, this.programId);
    return this.getTokenVault(pda);
  }
}

// ─── Convenience exports ─────────────────────────────────────────────────────

export { LAMPORTS_PER_SOL } from "@solana/web3.js";
