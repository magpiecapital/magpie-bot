import "dotenv/config";
import { PROGRAM_ID_V4 } from "../src/solana/program.js";
import { attestPrice } from "../src/services/price-attestor.js";

const BP_MINT = "BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy";
const DECIMALS = 9;

// Push samples at ~35s intervals so 8 land within a 5-min window.
// Account for the existing recent sample (~26s old now).
for (let i = 0; i < 8; i++) {
  const t0 = Date.now();
  try {
    const sig = await attestPrice(BP_MINT, DECIMALS, undefined, PROGRAM_ID_V4);
    console.log(`[${i+1}/8] attested in ${Date.now()-t0}ms: ${sig || "(no sig)"}`);
  } catch (err) {
    console.log(`[${i+1}/8] FAILED: ${err.message}`);
  }
  if (i < 7) {
    console.log(`  sleeping 35s before next push...`);
    await new Promise(r => setTimeout(r, 35_000));
  }
}
console.log("Done. TWAP should be warm.");
process.exit(0);
