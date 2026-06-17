import { PublicKey, Connection } from "@solana/web3.js";
import "dotenv/config";

const V4 = new PublicKey("HA1hgvskN1goEsb33rNHFBcDXBaYyLyyqfGwGMgTUwNo");
const BP = new PublicKey("BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy");
const LENDER = new PublicKey("4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx");

const [pool] = PublicKey.findProgramAddressSync([Buffer.from("pool"), LENDER.toBuffer()], V4);
const [priceFeed] = PublicKey.findProgramAddressSync([Buffer.from("price_v3"), BP.toBuffer(), pool.toBuffer()], V4);

const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com");
const ph = await conn.getAccountInfo(priceFeed);
if (!ph) { console.log("PriceHistory MISSING"); process.exit(1); }

const d = ph.data;
const head_index = d.readUInt8(8 + 32 + 32 + 32);
const count = d.readUInt8(8 + 32 + 32 + 32 + 1);
console.log("PriceHistory at", priceFeed.toBase58());
console.log("  size:", d.length, "bytes");
console.log("  head_index:", head_index, "  count:", count, "  (MIN_SAMPLES_FOR_TWAP=8)");

const samplesOffset = 8 + 32 + 32 + 32 + 1 + 1 + 6;
let earliestTs = null, latestTs = null;
let recentSamples = [];
for (let i = 0; i < count; i++) {
  const off = samplesOffset + i * 16;
  const price = d.readBigUInt64LE(off);
  const ts = Number(d.readBigInt64LE(off + 8));
  if (!earliestTs || ts < earliestTs) earliestTs = ts;
  if (!latestTs || ts > latestTs) latestTs = ts;
  recentSamples.push({ price: price.toString(), ts, age: Math.floor(Date.now()/1000) - ts });
}
const spanS = latestTs && earliestTs ? latestTs - earliestTs : 0;
console.log("  history span:", spanS, "s  (MIN_HISTORY_SECONDS=300)");
console.log("  earliest:", earliestTs ? new Date(earliestTs*1000).toISOString() : "-");
console.log("  latest:  ", latestTs ? new Date(latestTs*1000).toISOString() : "-");
console.log("  samples:", recentSamples.slice(-5));
console.log();
const twapReady = count >= 8 && spanS >= 300;
console.log("TWAP READY?", twapReady ? "YES" : "NO");
if (!twapReady) {
  if (count < 8) console.log("  -> need", 8 - count, "more samples (attestor pushes every ~60s; ~5 min wait)");
  if (spanS < 300) console.log("  -> need", 300 - spanS, "more seconds of history");
}
