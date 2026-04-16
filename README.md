# BagBank Bot

Telegram bot for memecoin-collateralized SOL loans on Solana.

Users deposit SPL tokens (memecoins) as collateral, receive SOL loans at fixed LTV tiers, and repay to reclaim their bags.

## Architecture

```
TG User ──▶ @BagBankBot ──▶ Custodial wallet (per user)
                              │
                              ▼
                        Anchor program (on-chain)
                              │
                              ▼
                    Liquidation backend (off-chain)
```

Uses wrapped SOL (wSOL) under the hood; users only ever see native SOL.

## Stack

- **grammY** — Telegram bot framework
- **@coral-xyz/anchor** — Solana program client
- **PostgreSQL** — user/wallet/position storage
- **Node.js 20+**

## Setup

```bash
cp .env.example .env
# Fill in values
npm install
npm run db:migrate
npm run dev
```
