/**
 * Jupiter swap utility — swaps an SPL token into native SOL.
 *
 * `wrapAndUnwrapSol: true` lets Jupiter auto-unwrap wSOL into native SOL on
 * the user's behalf, so the lender's SOL balance increases directly.
 */
import axios from "axios";
import {
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

export async function swapTokenToSol(connection, lenderKeypair, collateralMint, rawAmount) {
  console.log(`\n💱 Swapping ${collateralMint.toBase58()} → SOL via Jupiter (amount=${rawAmount})`);

  try {
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${collateralMint.toBase58()}&outputMint=${SOL_MINT}&amount=${rawAmount}&slippageBps=500`;
    const quoteResp = await axios.get(quoteUrl, { timeout: 10_000 });
    if (!quoteResp.data) throw new Error("Jupiter returned no quote");
    const quote = quoteResp.data;
    const expectedSolLamports = quote.outAmount;
    console.log(`   Expected: ${Number(expectedSolLamports) / 1e9} SOL (impact ${quote.priceImpactPct}%)`);

    const swapResp = await axios.post(
      "https://quote-api.jup.ag/v6/swap",
      {
        quoteResponse: quote,
        userPublicKey: lenderKeypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      },
      { timeout: 10_000, headers: { "Content-Type": "application/json" } },
    );

    if (!swapResp.data?.swapTransaction) throw new Error("No swap transaction returned");

    const txBuf = Buffer.from(swapResp.data.swapTransaction, "base64");
    let tx;
    let sig;
    try {
      tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([lenderKeypair]);
      sig = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    } catch {
      tx = Transaction.from(txBuf);
      tx.partialSign(lenderKeypair);
      sig = await connection.sendTransaction(tx, [lenderKeypair], {
        skipPreflight: false,
        maxRetries: 3,
      });
    }

    console.log(`   Sent: ${sig}`);
    const conf = await connection.confirmTransaction(sig, "confirmed");
    if (conf.value.err) throw new Error(`Swap confirm failed: ${JSON.stringify(conf.value.err)}`);

    console.log(`✅ Swap confirmed`);
    return {
      success: true,
      transaction: sig,
      solLamports: Number(expectedSolLamports),
    };
  } catch (err) {
    console.error(`❌ Swap failed: ${err.message}`);
    if (err.response) console.error("   API:", err.response.data);
    return { success: false, error: err.message };
  }
}
