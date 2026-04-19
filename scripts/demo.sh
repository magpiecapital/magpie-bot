#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Agent Vault Protocol — Live Demo Script
#
# Runs on a local Solana test validator. Demonstrates the full lifecycle:
#   1. Deploy the program
#   2. Create a vault with spending policies
#   3. Fund the vault
#   4. Agent spends successfully
#   5. Agent hits per-transaction limit → reverts
#   6. Agent hits daily limit → reverts
#   7. Owner revokes agent → spend fails
#   8. Owner withdraws and closes vault
#
# Usage:
#   ./scripts/demo.sh
#
# Prerequisites:
#   - solana-test-validator (Solana CLI)
#   - anchor (Anchor CLI)
#   - Node.js 18+
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Colors
G='\033[0;32m'  # Green
Y='\033[1;33m'  # Yellow
R='\033[0;31m'  # Red
C='\033[0;36m'  # Cyan
B='\033[1m'     # Bold
N='\033[0m'     # Reset

step=0
function step() {
  step=$((step + 1))
  echo ""
  echo -e "${Y}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
  echo -e "${B}  Step ${step}: ${1}${N}"
  echo -e "${Y}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
  echo ""
}

function success() {
  echo -e "  ${G}✓ ${1}${N}"
}

function fail_expected() {
  echo -e "  ${R}✗ ${1} (expected — policy enforced!)${N}"
}

function info() {
  echo -e "  ${C}→ ${1}${N}"
}

# ──────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${B}╔══════════════════════════════════════════════════════════════╗${N}"
echo -e "${B}║          Agent Vault Protocol — Live Demo                   ║${N}"
echo -e "${B}║          Programmable Wallets for AI Agents on Solana       ║${N}"
echo -e "${B}╚══════════════════════════════════════════════════════════════╝${N}"
echo ""

# ──────────────────────────────────────────────────────────────────────────────
step "Starting local Solana test validator"

# Kill any existing validator
pkill -f solana-test-validator 2>/dev/null || true
sleep 1

solana-test-validator --quiet --reset &
VALIDATOR_PID=$!
sleep 3

solana config set --url localhost --keypair ~/.config/solana/id.json > /dev/null 2>&1
success "Test validator running (PID: $VALIDATOR_PID)"

# Ensure we have a funded keypair
solana airdrop 100 > /dev/null 2>&1
BALANCE=$(solana balance | awk '{print $1}')
success "Wallet funded: ${BALANCE} SOL"

# ──────────────────────────────────────────────────────────────────────────────
step "Deploying Agent Vault program"

anchor deploy --provider.cluster localnet 2>&1 | tail -3
PROGRAM_ID="J9R83EHNJtrzwcS9PxJ9yyLs4SrWAsgQ6Laf6zNBeF8t"
success "Program deployed: ${PROGRAM_ID}"

# ──────────────────────────────────────────────────────────────────────────────
step "Running the demo scenario"

# Run the TypeScript demo
npx ts-node --esm scripts/demo-scenario.ts

# ──────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${B}╔══════════════════════════════════════════════════════════════╗${N}"
echo -e "${B}║                    Demo Complete                             ║${N}"
echo -e "${B}╚══════════════════════════════════════════════════════════════╝${N}"
echo ""

# Cleanup
kill $VALIDATOR_PID 2>/dev/null || true
success "Test validator stopped"
echo ""
