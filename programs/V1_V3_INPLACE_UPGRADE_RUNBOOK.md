# V1 + V3 In-Place Security Upgrade — Runbook

**What this is.** Ship the Sec3-derived security fixes (PR #674) into the two live unaudited pools
by **upgrading the existing programs in place** — same program ids, same pools, same LP balances,
same live loans. This is a code upgrade, **not** a new pool, new id, or migration.

**Why in-place is safe here.** The ports changed **zero account layout** (no struct field added/
removed, no `space`/`realloc` change — verified against the PR #674 diff). Existing pool/loan/LP
accounts stay byte-identical and keep working under the new code.

**One behavior change to existing loans (Q-02):** the new code refuses to extend an **overdue**
loan (it gets liquidated instead of rolled). Affects the 3 live V1 loans only if one goes overdue
and tries to extend. All other guards (H-01 custody, fee round-ups, M-04 price bound) fire only on
new borrows/extends/price-updates — already-locked collateral is not retroactively re-checked.

---

## Facts verified 2026-08-14 (re-verify at deploy time)

| Pool | Program id | Upgrade authority | On-chain size | Hardened build | Fit |
|---|---|---|---|---|---|
| V1 | `4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh` | `3FA8bGKuc4dK2pcmjA46zzxNWn2Pf5YT32jGfbSdwkWB` | 452,008 B | 465,328 B | **+13,320 B → EXTEND first** |
| V3 | `B8AwYzFmc3ZB5EWWVtJcJhJtEmKL78W5i3kZrL1uMCmP` | `3FA8bGKuc4dK2pcmjA46zzxNWn2Pf5YT32jGfbSdwkWB` | 528,664 B | 500,848 B | smaller → fits, deploy directly |

**Artifacts** (built from main @ `83c873a`, staged at `~/magpie-bot/programs/.upgrade-artifacts/`):
- V1 `magpie_lending.so` — sha256 `2621723ba90a9d457707da76dafd3359e1e949ef1441f6325db5fbdbe5267d8b`
- V3 `magpie_lending_v3.so` — sha256 `763d698c442cf6c20a5a6bea4731c85e608ccfd80e392d26e16d8587cd988300`

> The source `declare_id` already equals each live id, so these artifacts are correct for in-place.
> Prefer to rebuild from source yourself (trust) — recipe: deploy plan §3b, then `cargo build-sbf`;
> `declare_id` unchanged so the rebuilt `.so` upgrades the same id.

---

## Commands (mainnet). Set `AUTH` to your `3FA8bGKu…` authority keypair path.

```bash
AUTH=/path/to/3FA8bGKu-authority-keypair.json    # <-- your key; must be the funded payer too
BASE=~/magpie-bot/programs/.upgrade-artifacts

# ---------- V3 first (fits; no extend) ----------
solana program deploy "$BASE/magpie_lending_v3.so" \
  --program-id B8AwYzFmc3ZB5EWWVtJcJhJtEmKL78W5i3kZrL1uMCmP \
  --upgrade-authority "$AUTH" --keypair "$AUTH" --url mainnet-beta
solana program show B8AwYzFmc3ZB5EWWVtJcJhJtEmKL78W5i3kZrL1uMCmP --url mainnet-beta   # confirm slot advanced

# ---------- V1 (extend +20KB, then deploy) ----------
solana program extend 4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh 20480 \
  --keypair "$AUTH" --url mainnet-beta
solana program deploy "$BASE/magpie_lending.so" \
  --program-id 4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh \
  --upgrade-authority "$AUTH" --keypair "$AUTH" --url mainnet-beta
solana program show 4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh --url mainnet-beta   # confirm slot advanced
```

**If `3FA8bGKu` is a Squads/multisig, not a plain keypair:** don't use the direct command — write
the `.so` to a buffer (`solana program write-buffer <so>`), `set-buffer-authority` to the multisig,
then upgrade via the multisig proposal that calls `bpf_loader_upgradeable::upgrade`. Tell me and I'll
give the exact buffer flow.

## Post-deploy checks (do for both)
- `solana program show <id>` — "Last Deployed In Slot" advanced; "Authority" still `3FA8bGKu`.
- Bot: do one tiny real borrow → repay on each pool; confirm no `AccountNotInitialized`/decode errors
  (existing loan accounts must still decode — they will, layout unchanged).
- Watchdog green; no repay/liquidate simulate-fails.

## Rollback
Redeploy the **previous** `.so` at the same id with the same authority. Keep the current on-chain
build downloadable first: `solana program dump <id> <id>-prev.so --url mainnet-beta` **before** upgrading.

> ⚠️ No devnet dry-run was run (operator elected to go direct). The `dump`-before-upgrade above is
> the safety net — it makes rollback a single redeploy.
