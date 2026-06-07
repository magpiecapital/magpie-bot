# Magpie Capital — Telegram Bot

The Telegram-side of [Magpie Capital](https://magpie.capital) — a permissionless Solana lending protocol where users borrow SOL against approved memecoins and tokenized stocks.

Users deposit approved tokens as collateral, receive SOL at one of three loan tiers (Express / Quick / Standard), and repay to reclaim their collateral. The bot is custodial-by-design: each user's Magpie wallet IS the bot wallet, which is what lets the protocol co-sign repayments instantly.

## Official accounts

- **Site** — [magpie.capital](https://magpie.capital)
- **Wallet bot** (this repo) — [@magpie_capital_bot](https://t.me/magpie_capital_bot) · private 1:1 with the bot, holds your Magpie wallet
- **Community** — [@magpietalk](https://t.me/magpietalk) · public group chat, discussion and announcements
- **X** — [@MagpieLoans](https://x.com/MagpieLoans)

Anything claiming to be Magpie outside these four is impersonation.

## Architecture

```
TG User ──▶ @magpie_capital_bot ──▶ Custodial Magpie wallet (per user)
                                       │
                                       ▼
                                 Anchor program (Solana mainnet)
                                       │
                                       ▼
                          Liquidation backend (off-chain keeper)
```

Wrapped SOL (wSOL) is used under the hood for the on-chain flow; users only ever see native SOL in their wallet.

## Stack

- **grammY** — Telegram bot framework
- **@coral-xyz/anchor** — Solana program client
- **PostgreSQL** — user / wallet / position storage
- **Anthropic Claude** — Pip (in-app AI agent + community moderation)
- **Node.js 20+**

## Setup

```bash
cp .env.example .env
# Fill in values — see .env.example for what's required
npm install
npm run db:migrate
npm run dev
```

## Community moderation

This repo also runs Pip in the community group ([@magpietalk](https://t.me/magpietalk)) — URL filter, scam-pattern detection, CAPTCHA, image OCR, FUD classifier. All actions logged to `community_mod_actions` for audit; operator runs `/community_status` in the group for live state.
