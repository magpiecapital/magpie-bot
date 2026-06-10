#!/usr/bin/env bash
# Verify the latest governance snapshot for a given proposal looks healthy.
#
# Runs after the scheduler fires (or after a manual snapshot call) to
# confirm the file landed on disk, has the expected structure, hashes
# correctly, and reports the categorized counts.
#
# Usage:
#   ./scripts/verify-snapshot.sh MGP-001
#   ./scripts/verify-snapshot.sh MGP-001 ~/.magpie-private/snapshots
#
# Exit codes:
#   0 — snapshot looks healthy
#   1 — no snapshot found / snapshot looks broken
#   2 — script error

set -uo pipefail

PROPOSAL_ID="${1:-MGP-001}"
SNAPSHOT_DIR="${2:-$HOME/.magpie-private/snapshots}"

if [ ! -d "$SNAPSHOT_DIR" ]; then
  echo "✗ snapshot directory does not exist: $SNAPSHOT_DIR"
  exit 1
fi

# Most-recent snapshot file matching the proposal
SNAP=$(ls -t "$SNAPSHOT_DIR/${PROPOSAL_ID}-"*.json 2>/dev/null | head -1)
if [ -z "$SNAP" ] || [ ! -f "$SNAP" ]; then
  echo "✗ no snapshot found for $PROPOSAL_ID in $SNAPSHOT_DIR"
  echo "  expected pattern: ${PROPOSAL_ID}-YYYY-MM-DDTHH-MM-SS-mmmZ.json"
  exit 1
fi

# Hash the raw bytes — operator passes this to compute-distribution-plan
# via --expected-snapshot-hash for the integrity-bound execution.
HASH=$(python3 -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$SNAP")

echo "═══ Snapshot verification — ${PROPOSAL_ID} ═══"
echo ""
echo "  file:    $(basename "$SNAP")"
echo "  path:    $SNAP"
echo "  size:    $(wc -c < "$SNAP" | tr -d ' ') bytes"
echo "  mode:    $(stat -f '%Mp%Lp' "$SNAP" 2>/dev/null || stat -c '%a' "$SNAP" 2>/dev/null)"
echo "  hash:    $HASH"
echo ""

# Parse + sanity-check the structure
python3 - "$SNAP" "$PROPOSAL_ID" <<'PY'
import json, sys

snap_path, expected_id = sys.argv[1], sys.argv[2]
with open(snap_path) as f:
    d = json.load(f)

errors = []
def check(condition, msg):
    if not condition: errors.append(msg)

check(d.get('proposal_id') == expected_id, f"proposal_id mismatch (got {d.get('proposal_id')}, expected {expected_id})")
check(d.get('scope_version') == 'v2-categorized', f"scope_version is {d.get('scope_version')}, expected v2-categorized")
check('totals' in d, "missing 'totals' block")
check('categories' in d, "missing 'categories' block")
check('combined_eligible_set' in d, "missing 'combined_eligible_set' array")

if errors:
    for e in errors: print(f"  ✗ {e}")
    sys.exit(1)

t = d['totals']
print(f"  taken_at:  {d.get('taken_at_utc', '?')}")
print()
print(f"  totals:")
print(f"    holders:                  {t['holders_count']:>6,}")
print(f"    collateralized_borrowers: {t['collateralized_count']:>6,}")
print(f"    lp_providers:             {t['lp_providers_count']:>6,}")
print(f"    unique_eligible (dedup):  {t['unique_eligible_count']:>6,}")
print()
print(f"  weighted totals:")
print(f"    held $MAGPIE:              {int(t['total_held_raw']) / 1e6:>15,.2f} tokens (raw / 1e6)")
print(f"    collateralized $MAGPIE:    {int(t['total_collateralized_raw']) / 1e6:>15,.2f} tokens")
print(f"    LP shares:                 {int(t['total_lp_shares']) / 1e9:>15,.4f} (raw / 1e9 ≈ SOL-equiv)")

# Overlap analysis — useful sanity check
combined_n = len(d['combined_eligible_set'])
sum_per_cat = t['holders_count'] + t['collateralized_count'] + t['lp_providers_count']
overlap = sum_per_cat - combined_n
print()
print(f"  overlap analysis:")
print(f"    sum of category memberships: {sum_per_cat:>6,}")
print(f"    unique wallets:              {combined_n:>6,}")
print(f"    wallets in multiple categories: {overlap:>6,}")

# Sanity check the canonical-hash field if it's embedded — newer snapshot
# format puts it in stdout. Older format may have nothing. Either is fine.
PY

RC=$?
echo ""
if [ $RC -eq 0 ]; then
  echo "✓ snapshot looks healthy"
  echo ""
  echo "Next step — compute a distribution plan with the hash binding:"
  echo ""
  echo "  DISTRIBUTION_PLAN_OUT_DIR=\$HOME/.magpie-private/distributions \\"
  echo "    node scripts/compute-distribution-plan.js \\"
  echo "      \"$SNAP\" \\"
  echo "      --holder-pool-sol <N> \\"
  echo "      --expected-snapshot-hash \"$HASH\" \\"
  echo "      --memo \"${PROPOSAL_ID} distribution round 1\""
else
  echo "✗ snapshot structure has problems"
  exit 1
fi
