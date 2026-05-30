# Magpie Operations Runbook

Reference for "something looks wrong, what do I do." Read this when an alert
fires or you spot something off on the dashboard.

## Where each piece runs

| Component | Host | URL / address |
|---|---|---|
| Telegram bot | Railway (`magpie-bot` service) | @magpie_capital_bot |
| Site (Next.js) | Vercel (`magpie-site`) | magpie.capital |
| Solana program | mainnet-beta | `4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh` |
| Pool PDA | mainnet-beta | `EynWtuRMUKU3zHzfLv7Y5Qu6MWpwqG17X91QAuHSww9u` |
| Lender / fee wallet | (your wallet) | `4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx` |
| Primary DB | Railway Postgres | `DATABASE_URL` env |
| DR standby | Neon Postgres | `DATABASE_URL_SECONDARY` env |
| RPC primary | Helius (Developer plan) | `SOLANA_RPC_URL` env |
| RPC fallback | Solana public mainnet | `SOLANA_RPC_URL_BACKUP` env |

## Alerts you'll receive (Telegram DM from @magpie_capital_bot)

| Alert text | Means | Do |
|---|---|---|
| "Helius credits at X%" | Approaching cap | If 50–75%: monitor. 90%+: log into Helius and consider topping up or upgrading. RPC failover kicks in if you hit cap, but performance degrades. |
| "DATABASE DOWN" | Primary DB unreachable 6+ min | Bot has auto-failed-over to standby. Check Railway dashboard for the Postgres service. Restart it if it's crashed. |
| "DR standby DB unreachable" | Weekly probe failed | The failover safety net is broken. Log into Neon, check the project hasn't been paused for inactivity. |
| "Database Recovered" | Primary is back | No action — informational. |

## Quick-check URLs

| What | URL |
|---|---|
| Real protocol state (login as creator) | https://www.magpie.capital/admin |
| Liveness probe (public) | https://www.magpie.capital/api/v1/health |
| Approved tokens list | https://www.magpie.capital/api/v1/tokens |
| Pool stats | https://www.magpie.capital/api/v1/pool/stats |
| Railway logs | `railway logs --service=magpie-bot` |
| Vercel deploys | `npx vercel ls magpie-site` |

## Common scenarios

### "Borrows are failing"

1. Check `/api/v1/health` — if `borrowingEnabled: false`, the bot itself thinks something is wrong. Look at `botServices` to see which subsystem.
2. Try a fresh `/borrow` yourself in Telegram. The error message will identify the layer:
   - "ENOENT lender-keypair" → env var missing on Railway
   - "Price feed too stale" → price attestor stopped. Check `[PriceAttestor]` in Railway logs.
   - "Insufficient liquidity" → pool is fully borrowed. Deposit more via /earn or wait for repays.
3. If logs show "All RPC endpoints failed" → both Helius AND public mainnet are down (rare). Wait it out or add a third RPC URL to `SOLANA_RPC_URL_BACKUP` (comma-separated).

### "Dashboard shows wrong / stale data"

1. Hard refresh (Cmd+Shift+R). Vercel CDN can cache 30–60s.
2. If still wrong, check `/api/v1/health` directly — if that's also wrong, the bot endpoint is the issue, not the cache.
3. Check `railway logs --service=magpie-bot | tail -50` for recent errors.

### "Approved token count not growing"

1. Check `/api/v1/health` — if `screener: ok`, the screener is running. The audit is just being strict.
2. Run `railway logs --service=magpie-bot | grep 'screener.*result'` to see verdicts. Most rejects should be `rej_transient` (too young) or `rej_verdict` (concentration / honeypot).
3. If screener says "stale": restart the service from Railway dashboard.

### "Bot stopped responding to commands"

1. Check Railway — has the service crashed? Look at the "Deployments" tab.
2. `railway logs --service=magpie-bot | tail -100` — look for unhandled exceptions or `getUpdates failed`.
3. Restart from the Railway UI ("Restart service") as first resort.

### "Pool is paused"

This only happens if you (or someone with the admin key) called the pause instruction. The admin dashboard will show a red ⏸ banner. To unpause, you need to call `resume_pool` from the lender keypair. There's no script for this yet — ping me to write one.

## Standard recovery first-aid

1. **Restart the bot**: Railway → magpie-bot service → … → Restart. Takes ~30s. Often fixes transient state corruption.
2. **Redeploy from `main`**: Railway should auto-deploy on push. If it didn't pick up the latest commit, force with `git commit --allow-empty -m "redeploy" && git push`.
3. **Check Helius status**: status.helius.dev. If they have an incident, our failover should already be active.
4. **Check Solana status**: status.solana.com. If the network is degraded, the whole ecosystem is.

## What's running on cron / interval

| Service | Interval | What it does |
|---|---|---|
| `loan-watcher` | 60s | Watches loans approaching due date, DMs users to repay |
| `health-watcher` | 120s | Watches loan health ratios, DMs users when collateral drops |
| `db-health` | 120s | Pings primary DB |
| `risk-engine` | 300s | Recomputes token risk profiles |
| `pump-watcher` | 300s | Pump alerts for users (collateral 2x/3x/5x) |
| `token-screener` | 600s | Discovery + audit + auto-approve / queue |
| `helius-usage-watcher` | 3600s | Credit usage check |
| `token-health` | 3600s | Re-audits enabled mints for authority flips |
| `price-attestor` | 45s | Refreshes on-chain price feeds for active-loan mints |
| `db-standby-probe` | 7d | Tests Neon failover path |

## When to call Claude

Anything you can't resolve with the steps above. The model is:
1. You diagnose with this runbook.
2. If you can't fix it in 15 min, open a Claude session and share the symptoms + the relevant log lines.
3. I'll patch, deploy, and verify with you.

Don't try to debug ts/anchor/rust yourself unless you want to.

## Funds & withdrawal

| What | Where | How to access |
|---|---|---|
| Your protocol fee cut (20% of every loan fee) | Lender's wSOL ATA | Currently sits as wSOL — needs an "unwrap to native SOL" step (no script yet, ask Claude when you want to take fees out) |
| Your LP position fees (80% × your share) | Pool vault | Withdrawable via `/earn` page → Withdraw tab |
| Lender wallet native SOL | `4JSSS…zPAx` | Standard Phantom send (you have the private key) |

## Keep these accessible

- Helius dashboard login (for credit usage / API key rotation)
- Railway login (for env vars, restarts, logs)
- Vercel login (for env vars, deploys)
- Neon dashboard login (for standby DB)
- Phantom with the lender private key (for protocol operations)

Lose any of these and you lose your ability to operate the protocol. Back them up.
