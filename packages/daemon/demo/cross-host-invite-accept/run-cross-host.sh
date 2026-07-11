#!/usr/bin/env bash
# Drive the whole cross-host invite/accept demo end to end:
#   1. mint an invitation + publish a capability on the minion.town Pet Daemon,
#   2. accept it from a LOCAL Pet Daemon over wss://minion.town/ocapn-daemon,
#   3. round-trip a capability.
#
# Requires: SSM reach to the minion host (this repo's minion-ssm.py or
# demo/minion-town/ssm.sh) and a built monorepo (`yarn install`; on a noexec
# /tmp set TMPDIR to an exec mount for the install only). Run from packages/daemon.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
daemon_dir="$(cd "$here/../.." && pwd)"
SSM="${SSM:-python3 $here/minion-ssm.py}"
WS_URL_OVERRIDE="${WS_URL_OVERRIDE:-wss://minion.town/ocapn-daemon}"

echo "== minting invitation on minion.town Pet Daemon =="
mint="$($SSM "docker exec endo-pet-daemon sh -lc 'cd /app/packages/daemon && node demo/cross-host-invite-accept/minion-mint-invitation.mjs 2>&1'" 120)"
echo "$mint"
INVITATION="$(printf '%s\n' "$mint" | sed -n 's/^INVITATION //p')"
ADDER="$(printf '%s\n' "$mint" | sed -n 's/^ADDER //p')"
[ -n "$INVITATION" ] || { echo "no invitation minted" >&2; exit 1; }

echo "== accepting from a local Pet Daemon over $WS_URL_OVERRIDE =="
cd "$daemon_dir"
WS_URL_OVERRIDE="$WS_URL_OVERRIDE" INVITATION="$INVITATION" ADDER="$ADDER" \
  node demo/cross-host-invite-accept/local-accept-invitation.mjs
