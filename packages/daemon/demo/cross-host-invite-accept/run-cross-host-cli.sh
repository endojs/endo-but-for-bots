#!/usr/bin/env bash
# The pure-CLI variant of the cross-host invite/accept demo: the same
# Pet-Daemon-to-Pet-Daemon pairing as run-cross-host.sh, but driven end to end
# by the `endo` CLI binaries on both hosts instead of the programmatic host
# facet:
#   1. `endo invite` on the minion.town daemon mints the invitation,
#   2. a LOCAL Pet Daemon is booted and given `@nets/ocapn` with
#      `endo start` / `endo store` / `endo make` / `endo mv`,
#   3. the invitation's loopback `ws:url` hint is rewritten to the public
#      wss endpoint (rewrite-ws-url.mjs; the Noise designator is untouched),
#   4. `endo accept` redeems it over wss://minion.town/ocapn-daemon + Noise IK,
#   5. `endo send` / `endo inbox` round-trip messages BOTH directions across
#      the single session the local side dialed.
#
# The only non-CLI step is the locator rewrite in (3), a NAT/ingress detail:
# minion binds a loopback WebSocket reachable from outside only through Caddy
# TLS on 443, so the advertised hint needs the public address. Everything the
# pet-daemon protocol does — mint, redeem, register, message — is exercised
# through the shipped `endo` subcommands.
#
# Requires: SSM reach to the minion host (this repo's minion-ssm.py or
# demo/minion-town/ssm.sh) and a built monorepo (`yarn install`; on a noexec
# /tmp set TMPDIR to an exec mount for the install only). Run from packages/daemon.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
daemon_dir="$(cd "$here/../.." && pwd)"
repo_root="$(cd "$daemon_dir/../.." && pwd)"
SSM="${SSM:-python3 $here/minion-ssm.py}"
WS_URL_OVERRIDE="${WS_URL_OVERRIDE:-wss://minion.town/ocapn-daemon}"

endo() { node "$repo_root/packages/cli/bin/endo.cjs" "$@"; }
# The minion daemon's control socket lives at /data/endo.sock in its container;
# the CLI finds it through ENDO_SOCK (see @endo/where).
minion_endo="docker exec -e ENDO_SOCK=/data/endo.sock endo-pet-daemon node /app/packages/cli/bin/endo.cjs"

# Isolated local daemon state; the socket needs a short path even when the
# state itself lives in the repo tree.
demo_dir="$daemon_dir/tmp/demo-cli-xhost-$$"
export XDG_STATE_HOME="$demo_dir/state"
export XDG_RUNTIME_DIR="$demo_dir/run"
export XDG_CACHE_HOME="$demo_dir/cache"
export ENDO_SOCK="${TMPDIR:-/tmp}/endo-cli-xhost-$$.sock"
# Ephemeral gateway port so this demo daemon never clashes with a daemon the
# user already runs on the default 8920.
export ENDO_ADDR="127.0.0.1:0"
guest="garden-cli-$$"

cleanup() {
  endo stop >/dev/null 2>&1 || true
  rm -rf "$demo_dir" "$ENDO_SOCK" || true
  # Drop the per-run guest from minion's pet store so reruns stay tidy.
  $SSM "$minion_endo rm $guest" 60 >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== 1. endo invite on the minion.town Pet Daemon =="
mint_out="$($SSM "$minion_endo invite $guest" 120)"
invitation="$(printf '%s\n' "$mint_out" | grep -m1 '^endo://' || true)"
[ -n "$invitation" ] || { echo "endo invite printed no locator" >&2; exit 1; }
echo "minted: $invitation"

echo "== 2. boot a local Pet Daemon and install @nets/ocapn (all CLI) =="
cd "$daemon_dir"
endo start
endo ping
endo store --text '127.0.0.1:0' -n ws-listen-addr
endo make --UNCONFINED src/networks/ocapn.js -p '@agent' -w '@main' -n ocapn-network
endo mv ocapn-network '@nets/ocapn'
echo "installed @nets/ocapn"

echo "== 3. rewrite the loopback ws:url hint to $WS_URL_OVERRIDE =="
rewritten="$(node "$here/rewrite-ws-url.mjs" "$invitation" "$WS_URL_OVERRIDE")"

echo "== 4. endo accept over $WS_URL_OVERRIDE =="
printf '%s' "$rewritten" | endo accept minion
endo list | grep -qx minion || {
  echo "expected pet name 'minion' after endo accept" >&2
  exit 1
}
echo "accepted: pet name 'minion' bound locally"

echo "== 5. message round-trip, both directions, over the dialed session =="
ping_msg="ping from the garden CLI over Noise ($$)"
pong_msg="pong from minion.town over the same session ($$)"
endo send minion "$ping_msg"
minion_inbox="$($SSM "$minion_endo inbox" 120)"
printf '%s\n' "$minion_inbox" | grep -F "$ping_msg" >/dev/null || {
  echo "minion host inbox did not receive the CLI message" >&2
  printf '%s\n' "$minion_inbox" >&2
  exit 1
}
printf '%s\n' "$minion_inbox" | grep -F "$ping_msg" | tail -1
$SSM "$minion_endo send $guest \"$pong_msg\"" 120 >/dev/null
local_inbox="$(endo inbox)"
printf '%s\n' "$local_inbox" | grep -F "$pong_msg" >/dev/null || {
  echo "local inbox did not receive minion's reply" >&2
  printf '%s\n' "$local_inbox" >&2
  exit 1
}
printf '%s\n' "$local_inbox" | grep -F "$pong_msg" | tail -1

echo "CROSS-HOST CLI DEMO PASSED"
