/**
 * One-shot: pull pump.fun + letsbonk.fun graduated tokens via the
 * screener's discovery sources and run them through the full vetting
 * pipeline. Tokens that pass our scam audit get approved or queued for
 * review; the rest are filtered out with reasons logged.
 *
 * Usage: railway run --service=magpie-bot node scripts/backfill-pumpfun-letsbonk.js
 */
import "dotenv/config";

async function main() {
  // Lazy imports so the script runs cleanly with the same module graph
  // as the bot at runtime on Railway.
  const screener = await import("../src/services/token-screener.js");

  console.log("=== Backfill: pump.fun + letsbonk.fun graduates ===");
  console.log();

  // The screener's startTokenScreener function takes a bot — but for a
  // one-shot we don't need DM notifications. We can directly trigger an
  // internal tick by calling the discovery + vetting flow ourselves.
  //
  // Simplest path: just invoke startTokenScreener with a no-op bot stub
  // so it runs one immediate cycle. We exit shortly after, before the
  // 10-minute interval fires again.
  const stubBot = { api: { sendMessage: async () => null } };

  const interval = screener.startTokenScreener(stubBot);
  console.log("Screener cycle kicked off. Waiting 90s for it to complete...");
  await new Promise((r) => setTimeout(r, 90_000));

  clearInterval(interval);

  const { query } = await import("../src/db/pool.js");
  const { rows: stats } = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM supported_mints WHERE enabled = TRUE) AS enabled,
       (SELECT COUNT(*)::int FROM supported_mints WHERE enabled = TRUE AND source ILIKE '%pump%') AS from_pump,
       (SELECT COUNT(*)::int FROM token_screen_queue WHERE status = 'pending') AS pending_review`,
  );
  console.log();
  console.log("After backfill:");
  console.log(`  enabled supported_mints: ${stats[0].enabled}`);
  console.log(`  of which pump.fun-sourced: ${stats[0].from_pump}`);
  console.log(`  pending manual review: ${stats[0].pending_review}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
