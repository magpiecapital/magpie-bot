/**
 * @magpiecapital/credit-sdk
 *
 * Read Magpie Credit Scores from any Solana program or TypeScript app.
 * 5 lines of code to integrate DeFi credit scoring into your protocol.
 *
 * @example
 * ```typescript
 * import { MagpieCredit } from "@magpiecapital/credit-sdk";
 * import { Connection, PublicKey } from "@solana/web3.js";
 *
 * const credit = new MagpieCredit(new Connection("https://api.mainnet-beta.solana.com"));
 * const score = await credit.getScore(new PublicKey("wallet..."));
 *
 * console.log(score.score);    // 720
 * console.log(score.tier);     // "Gold"
 * console.log(score.maxLtv);   // 35
 * ```
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";

// ─── Constants ──────────────────────────────────────────────────────────────

export const CREDIT_ORACLE_PROGRAM_ID = new PublicKey(
  "MagCrEdScoRe1111111111111111111111111111111",
);

export const CREDIT_SCORE_SEED = Buffer.from("credit-score");

// ─── Types ──────────────────────────────────────────────────────────────────

export enum CreditTier {
  Bronze = "Bronze",
  Silver = "Silver",
  Gold = "Gold",
  Platinum = "Platinum",
}

export interface CreditScore {
  /** The wallet this score belongs to */
  wallet: PublicKey;
  /** Credit score: 300-850 */
  score: number;
  /** Credit tier: Bronze, Silver, Gold, or Platinum */
  tier: CreditTier;
  /** Factor breakdown (0-100 each) */
  factors: {
    repaymentHistory: number;
    loanVolume: number;
    accountAge: number;
    collateralDiversity: number;
    liquidationRatio: number;
    protocolEngagement: number;
  };
  /** Tier benefits */
  maxLtv: number;
  feeRate: number;
  maxDurationDays: number;
  /** Number of loans scored */
  loansScored: number;
  /** Unix timestamp of last update */
  lastUpdated: number;
  /** PDA address of the score account */
  address: PublicKey;
}

export interface CreditScoreRaw {
  wallet: PublicKey;
  authority: PublicKey;
  score: number;
  tier: { bronze?: {} } | { silver?: {} } | { gold?: {} } | { platinum?: {} };
  fRepaymentHistory: number;
  fLoanVolume: number;
  fAccountAge: number;
  fCollateralDiversity: number;
  fLiquidationRatio: number;
  fProtocolEngagement: number;
  maxLtvBps: number;
  feeRateBps: number;
  maxDurationDays: number;
  loansScored: number;
  lastUpdated: { toNumber(): number };
  bump: number;
}

// ─── PDA derivation ─────────────────────────────────────────────────────────

/**
 * Derive the PDA for a wallet's credit score account.
 */
export function deriveCreditScorePDA(
  wallet: PublicKey,
  programId: PublicKey = CREDIT_ORACLE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [CREDIT_SCORE_SEED, wallet.toBuffer()],
    programId,
  );
}

// ─── Tier utilities ─────────────────────────────────────────────────────────

function parseTier(raw: any): CreditTier {
  if ("platinum" in raw) return CreditTier.Platinum;
  if ("gold" in raw) return CreditTier.Gold;
  if ("silver" in raw) return CreditTier.Silver;
  return CreditTier.Bronze;
}

export function tierFromScore(score: number): CreditTier {
  if (score >= 750) return CreditTier.Platinum;
  if (score >= 650) return CreditTier.Gold;
  if (score >= 500) return CreditTier.Silver;
  return CreditTier.Bronze;
}

export function tierBenefits(tier: CreditTier): {
  maxLtv: number;
  feeRate: number;
  maxDurationDays: number;
} {
  switch (tier) {
    case CreditTier.Platinum:
      return { maxLtv: 38, feeRate: 1.0, maxDurationDays: 30 };
    case CreditTier.Gold:
      return { maxLtv: 35, feeRate: 1.25, maxDurationDays: 14 };
    case CreditTier.Silver:
      return { maxLtv: 32, feeRate: 1.5, maxDurationDays: 7 };
    default:
      return { maxLtv: 30, feeRate: 1.5, maxDurationDays: 7 };
  }
}

// ─── Main SDK class ─────────────────────────────────────────────────────────

export class MagpieCredit {
  private connection: Connection;
  private programId: PublicKey;
  private program: Program | null = null;

  constructor(
    connection: Connection,
    programId: PublicKey = CREDIT_ORACLE_PROGRAM_ID,
  ) {
    this.connection = connection;
    this.programId = programId;
  }

  /**
   * Get the credit score for a wallet. Returns null if no score exists.
   *
   * @example
   * ```typescript
   * const score = await credit.getScore(walletPubkey);
   * if (score && score.score >= 650) {
   *   // Grant Gold+ tier benefits
   * }
   * ```
   */
  async getScore(wallet: PublicKey): Promise<CreditScore | null> {
    const [pda] = deriveCreditScorePDA(wallet, this.programId);

    try {
      const accountInfo = await this.connection.getAccountInfo(pda);
      if (!accountInfo) return null;

      // Deserialize the account data
      const program = this.getProgram();
      const raw = program.coder.accounts.decode(
        "CreditScoreAccount",
        accountInfo.data,
      ) as unknown as CreditScoreRaw;

      return {
        wallet: raw.wallet,
        score: raw.score,
        tier: parseTier(raw.tier),
        factors: {
          repaymentHistory: raw.fRepaymentHistory,
          loanVolume: raw.fLoanVolume,
          accountAge: raw.fAccountAge,
          collateralDiversity: raw.fCollateralDiversity,
          liquidationRatio: raw.fLiquidationRatio,
          protocolEngagement: raw.fProtocolEngagement,
        },
        maxLtv: raw.maxLtvBps / 100,
        feeRate: raw.feeRateBps / 100,
        maxDurationDays: raw.maxDurationDays,
        loansScored: raw.loansScored,
        lastUpdated: raw.lastUpdated.toNumber(),
        address: pda,
      };
    } catch {
      return null;
    }
  }

  /**
   * Check if a wallet has a credit score on-chain.
   */
  async hasScore(wallet: PublicKey): Promise<boolean> {
    const [pda] = deriveCreditScorePDA(wallet, this.programId);
    const info = await this.connection.getAccountInfo(pda);
    return info !== null;
  }

  /**
   * Get the tier for a wallet. Returns "Bronze" if no score exists.
   */
  async getTier(wallet: PublicKey): Promise<CreditTier> {
    const score = await this.getScore(wallet);
    return score?.tier ?? CreditTier.Bronze;
  }

  /**
   * Check if a wallet meets a minimum credit score threshold.
   *
   * @example
   * ```typescript
   * // Gate access: require Gold tier (650+)
   * const eligible = await credit.meetsThreshold(wallet, 650);
   * ```
   */
  async meetsThreshold(wallet: PublicKey, minScore: number): Promise<boolean> {
    const score = await this.getScore(wallet);
    return (score?.score ?? 0) >= minScore;
  }

  /**
   * Get scores for multiple wallets in a batch.
   */
  async getBatchScores(wallets: PublicKey[]): Promise<Map<string, CreditScore | null>> {
    const results = new Map<string, CreditScore | null>();
    const pdas = wallets.map((w) => deriveCreditScorePDA(w, this.programId)[0]);

    const accounts = await this.connection.getMultipleAccountsInfo(pdas);
    const program = this.getProgram();

    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i];
      const accountInfo = accounts[i];

      if (!accountInfo) {
        results.set(wallet.toBase58(), null);
        continue;
      }

      try {
        const raw = program.coder.accounts.decode(
          "CreditScoreAccount",
          accountInfo.data,
        ) as unknown as CreditScoreRaw;

        results.set(wallet.toBase58(), {
          wallet: raw.wallet,
          score: raw.score,
          tier: parseTier(raw.tier),
          factors: {
            repaymentHistory: raw.fRepaymentHistory,
            loanVolume: raw.fLoanVolume,
            accountAge: raw.fAccountAge,
            collateralDiversity: raw.fCollateralDiversity,
            liquidationRatio: raw.fLiquidationRatio,
            protocolEngagement: raw.fProtocolEngagement,
          },
          maxLtv: raw.maxLtvBps / 100,
          feeRate: raw.feeRateBps / 100,
          maxDurationDays: raw.maxDurationDays,
          loansScored: raw.loansScored,
          lastUpdated: raw.lastUpdated.toNumber(),
          address: pdas[i],
        });
      } catch {
        results.set(wallet.toBase58(), null);
      }
    }

    return results;
  }

  /**
   * Get the PDA address for a wallet's credit score account.
   * Useful for CPI integrations.
   */
  getScoreAddress(wallet: PublicKey): PublicKey {
    return deriveCreditScorePDA(wallet, this.programId)[0];
  }

  private getProgram(): Program {
    if (this.program) return this.program;

    const idl = require("../../idl/magpie-credit-oracle.json");
    const dummyWallet = new Wallet(Keypair.generate());
    const provider = new AnchorProvider(this.connection, dummyWallet, {
      commitment: "confirmed",
    });
    this.program = new Program(idl, provider);
    return this.program;
  }
}

// ─── Convenience functions ──────────────────────────────────────────────────

/**
 * Quick helper: get a credit score without creating a class instance.
 */
export async function getCreditScore(
  connection: Connection,
  wallet: PublicKey,
): Promise<CreditScore | null> {
  const client = new MagpieCredit(connection);
  return client.getScore(wallet);
}

/**
 * Quick helper: check if a wallet meets a minimum score.
 */
export async function meetsScoreThreshold(
  connection: Connection,
  wallet: PublicKey,
  minScore: number,
): Promise<boolean> {
  const client = new MagpieCredit(connection);
  return client.meetsThreshold(wallet, minScore);
}
