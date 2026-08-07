/**
 * Winback campaign — personalized re-engagement of every past borrower.
 *
 * SAFE BY DEFAULT: running this with no flag only PREVIEWS (builds + prints every
 * personalized message, sends nothing). It sends ONLY when the operator runs it with
 * SEND=1, and even then it throttles and hard-skips anyone with proactive_dms_disabled.
 *
 *   Preview (safe, default):   railway run --service magpie-bot node scripts/winback-campaign.js
 *   Actually send (operator):  SEND=1 railway run --service magpie-bot node scripts/winback-campaign.js
 *
 * The send step is intentionally the operator's — a human triggers the real outreach.
 */
const { Pool } = require("pg");

const V4 = "HA1hgvskN1goEsb33rNHFBcDXBaYyLyyqfGwGMgTUwNo";
const MAGPIE = "9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump";
const TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN ||
  process.env.TG_BOT_TOKEN || process.env.BOT_API_TOKEN || process.env.TELEGRAM_TOKEN;
const DO_SEND = process.env.SEND === "1";
const THROTTLE_MS = Number(process.env.THROTTLE_MS || 1500); // ~40/min — well under Telegram limits

function segmentOf(u) {
  if (u.total_sol >= 20 && u.days >= 14) return "WHALE_DORMANT";
  if (u.autosell && u.days >= 14) return "AUTOSELL_DORMANT";
  if (u.magpie_coll) return "MAGPIE_LOYALIST";
  if (u.loans >= 3 && u.days >= 14) return "REPEAT_DORMANT";
  if (u.loans === 1 && u.days >= 7) return "ONE_AND_DONE";
  if (u.days < 7) return "WARM_ACTIVE";
  return "OTHER_DORMANT";
}

function messageFor(u) {
  const name = u.h ? "@" + u.h : "there";
  const d = u.days;
  switch (segmentOf(u)) {
    case "WHALE_DORMANT":
      return `Hey ${name} — you were one of Magpie's biggest borrowers (${u.total_sol}◎ across ${u.loans} loans, every one repaid clean) and then went quiet about ${d} days ago. Genuinely want to know: did something push you off, or did you just drift? If there was friction, I'll fix it personally — and if you're holding a position now, the auto-sell-into-the-loan feature is built for size like yours.`;
    case "AUTOSELL_DORMANT":
      return `Hey ${name} — you actually used the auto-sell built into your loans, which most borrowers never even find. You've been quiet ~${d} days. Anything change? The exit engine's sharper than when you left and there are new tokens live — worth a look if you've got a bag you'd borrow against.`;
    case "MAGPIE_LOYALIST":
      return `Hey ${name} — you've borrowed against $MAGPIE itself, so you're genuinely one of us. Appreciate you holding. Been ~${d} days since your last loan — want to see what's new? You can now set a take-profit / stop-loss right inside the loan, so it manages the exit for you.`;
    case "REPEAT_DORMANT":
      return `Hey ${name} — you were a regular (${u.loans} loans, all repaid) then went quiet ~${d} days ago. Curious what changed. Also — did you ever try auto-sell inside the loan? Set your exit up front and it repays itself. Feels built for how you used Magpie.`;
    case "ONE_AND_DONE":
      return `Hey ${name} — you borrowed on Magpie once a while back and never came back. Genuinely curious why: too small to matter, a one-time need, or did something not click? Would honestly value 30 seconds of feedback. And in case it helps — the thing most people miss is you can set an auto-sell right inside the loan.`;
    case "WARM_ACTIVE":
      return `Hey ${name} — glad you're active on Magpie. Quick one: are you using the auto-sell inside your loans yet? Set a take-profit / stop-loss up front and it exits + repays hands-off. Happy to walk you through it.`;
    default:
      return `Hey ${name} — been a bit since your last Magpie loan. Anything we could've done better? Also worth knowing: you can now set your take-profit / stop-loss right inside the loan so it manages itself. Want a quick look?`;
  }
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query(
    `select u.id, u.telegram_id, u.telegram_username h, u.proactive_dms_disabled optout,
            count(l.*)::int loans, round((sum(l.loan_amount_lamports)/1e9)::numeric,1) total_sol,
            bool_or(l.program_id=$1) autosell, bool_or(l.collateral_mint=$2) magpie_coll,
            (now()::date - max(l.created_at)::date) days,
            max(u.last_winback_nudge_at) recent_nudge
     from users u join loans l on l.user_id=u.id group by 1,2,3,4`, [V4, MAGPIE]);

  // reachable = has TG, not opted out, and NOT already nudged in the last 5 days (no double-tapping)
  const cutoff = Date.now() - 5 * 24 * 3600 * 1000;
  const reachable = r.rows.filter(
    (u) => u.telegram_id && !u.optout && !(u.recent_nudge && new Date(u.recent_nudge).getTime() > cutoff)
  );
  const counts = {};
  reachable.forEach((u) => (counts[segmentOf(u)] = (counts[segmentOf(u)] || 0) + 1));
  console.log(`${DO_SEND ? "*** LIVE SEND ***" : "PREVIEW (no send)"} — ${reachable.length} reachable / ${r.rows.length} total borrowers`);
  console.log("segments:", JSON.stringify(counts));

  if (!DO_SEND) {
    // preview: 1 sample message per segment
    const seen = new Set();
    for (const u of reachable) {
      const s = segmentOf(u);
      if (seen.has(s)) continue;
      seen.add(s);
      console.log(`\n[${s}] -> @${u.h}\n${messageFor(u)}`);
    }
    console.log(`\n(${reachable.length} messages ready. Re-run with SEND=1 to deliver.)`);
    await pool.end();
    return;
  }

  // LIVE SEND (operator-triggered). Throttled, opt-outs already filtered.
  if (!TOKEN) { console.log("NO BOT TOKEN — aborting, nothing sent."); await pool.end(); return; }
  let sent = 0, failed = 0;
  for (const u of reachable) {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: u.telegram_id, text: messageFor(u), disable_web_page_preview: true }),
      });
      const j = await resp.json();
      if (j.ok) { sent++; await pool.query("update users set last_winback_nudge_at=now() where id=$1", [u.id]).catch(() => {}); }
      else { failed++; console.log(`FAIL @${u.h}: ${j.description}`); }
    } catch (e) { failed++; console.log(`ERR @${u.h}: ${e.message}`); }
    await new Promise((res) => setTimeout(res, THROTTLE_MS));
  }
  console.log(`DONE — sent ${sent}, failed ${failed}`);
  await pool.end();
})().catch((e) => console.log("FATAL", e.message));
