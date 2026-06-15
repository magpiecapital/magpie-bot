# magpie-lending-v3 — TWAP-protected lending program

Parallel deploy of the lending program with **on-chain TWAP** price
validation. Replaces v2's single-spot `PriceAttestation` account with
a rolling-buffer `PriceHistory` of 32 samples and validates borrow
LTV against the time-weighted average instead of the latest spot.

**Why this exists.** The 2026-06-07 $FATHER incident: an attacker
pumped a thin-liquidity pool, took loans against the inflated spot
price (which the v1/v2 attestor pushed on-chain a few seconds later),
dumped the token. With TWAP, the same attack requires sustaining
the pump for >5 minutes — economically much harder.

**v1 and v2 are untouched.** Existing loans on those programs continue
to behave normally. v3 is a third deploy at a fresh program ID. The
bot routes NEW memecoin borrows to v3 once `PROGRAM_ID_V3` is set in
env.

## What v3 changes

| Concern              | v1/v2 behavior                          | v3 behavior                                            |
|----------------------|------------------------------------------|---------------------------------------------------------|
| Price feed account   | `PriceAttestation` — single spot         | `PriceHistory` — ring buffer of 32 samples              |
| Update_price         | Overwrites the spot field                | Appends a sample (wraps when full)                      |
| Borrow validation    | spot must be < 2 min old, LTV vs spot    | TWAP over last 30 min, LTV vs min(TWAP, spot)           |
| Cold-start refusal   | none                                     | refuses < 8 samples or < 5 min of history               |
| Active-pump refusal  | none                                     | refuses if spot > TWAP + 15%                            |
| PDA seed prefix      | `b"price"`                               | `b"price_v3"` (distinct from v2 so accounts don't clash)|

## Pre-deploy checklist

1. **Generate the program keypair** (deterministic; commit the address
   not the secret):
   ```bash
   cd ~/bagbank-bot
   solana-keygen new -o target/deploy/magpie_lending_v3-keypair.json --no-bip39-passphrase
   solana address -k target/deploy/magpie_lending_v3-keypair.json
   ```
   Copy that address into `programs/magpie-lending-v3/src/lib.rs` —
   replace the placeholder in `declare_id!("MgpV3...")`. Also update
   `Anchor.toml` `[programs.localnet/devnet/mainnet]`.

2. **Build**:
   ```bash
   cd ~/bagbank-bot/programs/magpie-lending-v3
   anchor build
   ```
   Resolves to `target/deploy/magpie_lending_v3.so` and an IDL at
   `target/idl/magpie_lending_v3.json`.

3. **Devnet deploy first** (smoke test the TWAP logic with cheap SOL):
   ```bash
   solana airdrop 5 -u devnet
   anchor deploy --provider.cluster devnet --provider.wallet lender-keypair.json
   ```
   Then run `scripts/v3-init-pool.js` (see Init step below) on devnet.

4. **Mainnet deploy**:
   ```bash
   anchor deploy --provider.cluster mainnet --provider.wallet lender-keypair.json
   ```
   Expect ~3-5 SOL in deploy cost. Confirm `lender-keypair.json` has
   the funds before running.

5. **Initialize the v3 pool**:
   ```bash
   railway run node scripts/v3-init-pool.js
   ```
   This calls `initialize_pool` on v3 with the same authority as v1/v2.
   Pool funding happens separately via `/fundpool v3 <amount>` in TG.

6. **Set env vars on Railway**:
   ```
   PROGRAM_ID_V3=<the address from step 1>
   ROUTE_MEMECOINS_TO_V3=true
   ```

7. **Initialize price feeds for every active mint** (one-shot script).
   The on-chain TWAP needs samples before any borrow can pass — the
   attestor will start writing them automatically once `PROGRAM_ID_V3`
   is set. Plan: deploy + initialize the pool, let the attestor warm
   the buffers for ~30 min, then flip `ROUTE_MEMECOINS_TO_V3=true`.

## Rollback

If anything goes wrong with v3, flip `ROUTE_MEMECOINS_TO_V3=false`.
New borrows go back to v1 immediately. v3 loans (if any opened) continue
on v3 and can be repaid/extended via that program normally — they're
on-chain state that lives independently.

## Open / pending

- `scripts/v3-init-pool.js` is NOT yet written. Author it after deploy
  by copying `scripts/v2-init-pool.js` or the equivalent. The pool init
  is parameter-identical to v1/v2.
- The bot's `chooseProgramIdForCategory()` does NOT yet know about v3.
  After deploy, add a `PROGRAM_ID_V3` branch that routes when
  `ROUTE_MEMECOINS_TO_V3=true` AND category is memecoin (or null).
- IDL must be added to `src/solana/idl/` and the program registry in
  `src/solana/program.js`.
