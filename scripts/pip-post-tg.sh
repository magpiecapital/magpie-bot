#!/usr/bin/env bash
# Post a @MagpieLoans tweet (or arbitrary text) to @magpietalk via the
# prod bot. The local .env's TELEGRAM_BOT_TOKEN is a dev/test bot that
# is NOT in the prod community chat, so a local `node scripts/*.js`
# invocation fails with "Unauthorized". This wrapper runs the script
# under `railway run --service magpie-bot` so it picks up the prod
# bot token + DB + dedup table.
#
# Usage:
#   scripts/pip-post-tg.sh tweet  <x-url>
#   scripts/pip-post-tg.sh text   <file-or-->
#
# tweet:  X URL must match https://x.com/MagpieLoans/status/<id> — the
#         existing /crosspost allowlist + dedup + engagement-line
#         rotation applies.
# text:   reads stdin (-) or a file, posts verbatim to every enabled
#         community chat. No engagement footer. Caller owns the tone.
set -euo pipefail

mode="${1:-}"
if [[ "$mode" != "tweet" && "$mode" != "text" ]]; then
  echo "Usage: $0 tweet <x-url>   |   $0 text <file-or-->" >&2
  exit 2
fi
shift

case "$mode" in
  tweet)
    [[ $# -eq 1 ]] || { echo "tweet mode needs exactly 1 url" >&2; exit 2; }
    railway run --service magpie-bot node scripts/crosspost-tweet.js "$1"
    ;;
  text)
    [[ $# -eq 1 ]] || { echo "text mode needs exactly 1 file/-" >&2; exit 2; }
    railway run --service magpie-bot node scripts/community-broadcast.js "$1"
    ;;
esac
