#!/usr/bin/env node
/** Post the demo video + honest live stats to the TG community (@magpietalk). */
import { readFileSync } from "node:fs";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.error("ABORT: no TELEGRAM_BOT_TOKEN"); process.exit(1); }

const res = await fetch("https://www.magpie.capital/api/v1/stats", { signal: AbortSignal.timeout(20_000) });
const s = (await res.json())?.data;
if (!s?.totalLoansOriginated) { console.error("ABORT: stats unavailable"); process.exit(1); }
const repaidPct = ((s.repaidLoans / (s.repaidLoans + s.liquidatedLoans)) * 100).toFixed(1);

const caption = [
  "🐦 <b>Watch Magpie work — 60 seconds, sound on</b>",
  "",
  "A normal loan locks your collateral away. The market spikes — you just watch. <b>Not here.</b>",
  "",
  "The new walkthrough runs on the real dashboard: borrow SOL, arm a take-profit ladder + stop-loss on the collateral itself. Targets hit → slices sell in-vault → the loan stays active. You never miss the candle.",
  "",
  "▶️ Also on the homepage: magpie.capital",
  "",
  `On-chain right now: ${s.totalLoansOriginated.toLocaleString("en-US")} loans · ${repaidPct}% repaid · ${Math.round(s.totalSolLent).toLocaleString("en-US")} SOL lent · ${s.totalUsers.toLocaleString("en-US")} users`,
].join("\n");

const video = readFileSync(process.env.HOME + "/magpie-site/public/media/how-it-works.mp4");
const form = new FormData();
form.append("chat_id", "@magpietalk");
form.append("video", new Blob([video], { type: "video/mp4" }), "magpie-how-it-works.mp4");
form.append("supports_streaming", "true");
form.append("parse_mode", "HTML");
form.append("caption", caption);

const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendVideo`, {
  method: "POST", body: form, signal: AbortSignal.timeout(180_000),
});
const j = await r.json().catch(() => ({}));
console.log("ok:", j.ok, "| message_id:", j.result?.message_id, "| chat:", j.result?.chat?.title || j.description);
if (!j.ok) process.exit(1);
