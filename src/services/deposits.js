import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { connection } from "../solana/connection.js";
import { query } from "../db/pool.js";

/**
 * List a user's SPL token balances that match supported_mints.
 * Returns [{ mint, symbol, decimals, rawAmount, humanAmount }]
 */
export async function getSupportedBalances(walletPubkey) {
  const owner = new PublicKey(walletPubkey);

  const [std, t22] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);

  const all = [...std.value, ...t22.value];
  const byMint = new Map();
  for (const acc of all) {
    const info = acc.account.data.parsed.info;
    const raw = BigInt(info.tokenAmount.amount);
    if (raw === 0n) continue;
    byMint.set(info.mint, {
      mint: info.mint,
      rawAmount: raw,
      decimals: info.tokenAmount.decimals,
    });
  }

  if (byMint.size === 0) return [];

  const mints = [...byMint.keys()];
  const { rows } = await query(
    `SELECT mint, symbol, name, decimals FROM supported_mints
     WHERE enabled = TRUE AND mint = ANY($1)`,
    [mints],
  );

  return rows.map((r) => {
    const bal = byMint.get(r.mint);
    return {
      mint: r.mint,
      symbol: r.symbol,
      name: r.name,
      decimals: r.decimals,
      rawAmount: bal.rawAmount.toString(),
      humanAmount: Number(bal.rawAmount) / 10 ** r.decimals,
    };
  });
}

/**
 * Get native SOL balance for a wallet.
 */
export async function getSolBalance(walletPubkey) {
  const lamports = await connection.getBalance(new PublicKey(walletPubkey));
  return lamports;
}
