#!/usr/bin/env bash
# Repeatable end-to-end OCapN-Noise-WS demo against minion.town.
#
# 1. Fetch the running daemon's current OcapnLocation from the host via SSM
#    (the Noise designator is freshly minted each daemon start, so read live).
# 2. Rewrite its loopback `ws:url` hint to the public wss endpoint.
# 3. Dial wss://minion.town/ocapn from here with the raw OCapN-Noise-WS client,
#    run Noise IK against the daemon's designator, fetch the 'greeter'
#    capability by swissnum, and invoke it — a full capability round-trip over
#    OCapN-Noise carried on a WebSocket through Caddy's TLS 443.
#
# Requires: garden AWS creds (~/.aws, garden-fleet) for SSM; run from an
# installed endo checkout of the WS branch (ESM deps resolve under
# packages/daemon). The client runs with cwd = packages/daemon so pnpm's
# per-package node_modules resolves @endo/* and ws.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DAEMON_PKG="$(cd "$HERE/../.." && pwd)"   # packages/daemon
: "${WSS_URL:=wss://minion.town/ocapn}"
: "${SWISSNUM:=greeter}"
: "${WHO:=the local peer}"
LOC=/tmp/minion-ocapn-location.json

echo "=== [1/3] fetch daemon location from minion.town via SSM ==="
"$HERE/ssm.sh" 'cat /opt/endo/ocapn-demo-location.json' \
  | sed -n '/### STDOUT:/,/### STDERR:/p' | grep -vE '^### ' | sed '/^$/d' > "$LOC"
cat "$LOC"

echo "=== [2/3] client dials $WSS_URL (ws:url hint rewritten to the public endpoint) ==="
cp "$HERE/ocapn-ws-client.mjs" "$DAEMON_PKG/demo/ocapn-ws-client.mjs"
cd "$DAEMON_PKG"
WS_URL_OVERRIDE="$WSS_URL" node demo/ocapn-ws-client.mjs "$LOC" "$SWISSNUM" "$WHO"

echo "=== [3/3] done ==="
