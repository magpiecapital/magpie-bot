# Agent Vault Protocol

**Programmable wallets for AI agents on Solana.**

Create vaults with on-chain spending policies — per-transaction limits, daily budgets, session keys, and instant revocation. Agents transact autonomously within bounds you control. Every action is enforced by the program, not the SDK.

## The Problem

AI agents need to spend money. Today, you either:
- Give them your private key (unsafe)
- Manually approve every transaction (defeats the purpose)
- Use a multisig (slow, no spending policies)

There is no standard for **programmatic, policy-enforced autonomous spending** on Solana.

## The Solution

Agent Vault is an Anchor program that creates **policy-enforced vault accounts** for AI agents:

```
Owner creates vault → sets limits → funds it → agent spends autonomously
```

The program enforces 6 security layers on every spend:

| Layer | Check | On failure |
|-------|-------|------------|
| 1 | Vault is active | `VaultInactive` |
| 2 | Session not expired | `SessionExpired` |
| 3 | Caller is assigned agent | `Unauthorized` |
| 4 | Amount ≤ per-tx limit | `ExceedsTransactionLimit` |
| 5 | Daily total ≤ daily cap | `ExceedsDailyLimit` |
| 6 | Balance ≥ amount + rent | `InsufficientFunds` |

All enforcement is on-chain. No amount of SDK or API manipulation can bypass it.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Owner Wallet                    │
│  - Creates vaults                                 │
│  - Sets spending policies                         │
│  - Funds, withdraws, revokes                      │
└──────────────────────┬──────────────────────────┘
                       │ create_vault()
                       ▼
┌─────────────────────────────────────────────────┐
│              Vault PDA (on-chain)                  │
│  seeds: ["vault", owner, agent]                   │
│                                                    │
│  spend_limit:    0.5 SOL per tx                   │
│  daily_limit:    2.0 SOL per day                  │
│  session_expiry: 2026-05-01T00:00:00Z             │
│  is_active:      true                              │
│  total_spent:    1.3 SOL                           │
│  tx_count:       7                                 │
└──────────────────────┬──────────────────────────┘
                       │ agent_spend()
                       ▼
┌─────────────────────────────────────────────────┐
│                 AI Agent Keypair                   │
│  - Signs spend transactions                       │
│  - Cannot modify policies                         │
│  - Cannot withdraw or close                       │
│  - Authority expires with session                 │
└─────────────────────────────────────────────────┘
```

## Quick Start

### Owner: Create and fund a vault
```typescript
import { AgentVaultOwner } from "@magpiecapital/agent-vault-sdk";

const vault = new AgentVaultOwner(connection, ownerKeypair);
const address = await vault.create(agentPubkey, {
  spendLimit: 0.1 * LAMPORTS_PER_SOL,   // max per transaction
  dailyLimit: 1.0 * LAMPORTS_PER_SOL,   // max per 24h window
  sessionDuration: 7 * 86400,            // 7-day session
});
await vault.deposit(address, 5 * LAMPORTS_PER_SOL);
```

### Agent: Spend from the vault
```typescript
import { AgentVaultAgent } from "@magpiecapital/agent-vault-sdk";

const agent = new AgentVaultAgent(connection, agentKeypair);
await agent.spend(vaultAddress, destination, 0.05 * LAMPORTS_PER_SOL);
// Program enforces all limits — reverts if any policy is violated
```

### REST API: For agents that don't speak Solana
```bash
# Derive vault address
GET /api/v1/vault/derive?owner=...&agent=...

# Check balance and policy
GET /api/v1/vault/info?address=...

# Spend (agent authenticates with keypair)
POST /api/v1/vault/spend
{ "vault": "...", "agentPrivateKey": "...", "destination": "...", "lamports": 50000000 }
```

## Instructions

| Instruction | Signer | Description |
|------------|--------|-------------|
| `create_vault` | Owner | Create vault PDA with agent and policy |
| `deposit` | Anyone | Fund the vault with SOL |
| `agent_spend` | Agent | Spend within policy bounds |
| `update_policy` | Owner | Change spend/daily limits |
| `extend_session` | Owner | Extend agent's session |
| `revoke_agent` | Owner | Immediately disable agent |
| `set_agent` | Owner | Swap to a new agent keypair |
| `owner_withdraw` | Owner | Withdraw SOL from vault |
| `close_vault` | Owner | Close vault, reclaim rent |

## Program Details

| | |
|---|---|
| **Program ID** | `J9R83EHNJtrzwcS9PxJ9yyLs4SrWAsgQ6Laf6zNBeF8t` |
| **Framework** | Anchor 0.30.1 |
| **Binary size** | 238 KB |
| **Account size** | 138 bytes + 8 discriminator |
| **PDA seeds** | `["vault", owner_pubkey, agent_pubkey]` |

## Use Cases

- **AI Trading Agents** — Give a trading bot a vault with a daily budget. It executes autonomously; when the cap hits, it stops.
- **API Payment Rails** — AI agents that consume paid APIs pay from their vault. Compatible with x402 HTTP 402 payment flows.
- **Multi-Agent Systems** — Run a fleet of specialized agents, each with its own vault, budget, and session. One owner controls them all.
- **Autonomous DAO Operations** — DAO governance sets vault policy; agents execute within bounds.

## Project Structure

```
programs/agent-vault/     Anchor program (Rust)
sdk/agent-vault/          TypeScript SDK
src/commands/vault.js     Telegram bot commands
src/api/vault-api.js      REST API for agents
scripts/demo.sh           Live demo script
tests/agent-vault.ts      Test suite
```

## Running the Demo

```bash
# Start local validator, deploy, and run full demo
./scripts/demo.sh
```

## Running Tests

```bash
anchor test
```

## Built With

- [Solana](https://solana.com) — High-performance blockchain
- [Anchor](https://anchor-lang.com) — Solana program framework
- [TypeScript](https://typescriptlang.org) — SDK and tests

## License

MIT
