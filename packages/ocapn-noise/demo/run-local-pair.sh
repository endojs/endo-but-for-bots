#!/usr/bin/env bash
# Milestone 1 demonstration: two local OS processes establish a Noise (IK)
# session over a real transport and round-trip an OCapN capability.
#
# Usage: demo/run-local-pair.sh <ws|tcp> [who]
# Runs a server process (publishes Greeter) and a client process (invokes it),
# capturing both processes' stderr into a transcript.
set -euo pipefail
scheme="${1:?usage: run-local-pair.sh <ws|tcp> [who]}"
who="${2:-Alice}"
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$(cd "$here/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/ocapn-demo-XXXXXX")"
loc="$work/server-location.json"
log="$work/transcript.log"

cleanup() { [ -n "${server_pid:-}" ] && kill "$server_pid" 2>/dev/null || true; }
trap cleanup EXIT

cd "$pkg"
echo "=== M1 local pair over $scheme — $(date -u +%FT%TZ) ===" | tee "$log"

# Bind loopback so the two local processes can reach each other.
DEMO_HOST=127.0.0.1 node demo/server.mjs "$scheme" "$loc" >>"$log" 2>&1 &
server_pid=$!

# Wait for the server to publish its location (max ~10s).
for _ in $(seq 1 100); do
  [ -s "$loc" ] && break
  sleep 0.1
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "server exited early; transcript:" >&2; cat "$log" >&2; exit 1
  fi
done
[ -s "$loc" ] || { echo "server never published a location" >&2; cat "$log" >&2; exit 1; }

echo "--- server location ---" | tee -a "$log"
cat "$loc" | tee -a "$log"
echo | tee -a "$log"

echo "--- client run ---" | tee -a "$log"
reply="$(node demo/client.mjs "$scheme" "$loc" "$who" 2> >(tee -a "$log" >&2))"
echo "CLIENT STDOUT REPLY: $reply" | tee -a "$log"

expected="hello, $who"
if [ "$reply" = "$expected" ]; then
  echo "RESULT: PASS ($scheme) — capability round-tripped: '$reply'" | tee -a "$log"
  echo "transcript: $log"
  exit 0
else
  echo "RESULT: FAIL ($scheme) — expected '$expected', got '$reply'" | tee -a "$log"
  echo "transcript: $log"
  exit 1
fi
