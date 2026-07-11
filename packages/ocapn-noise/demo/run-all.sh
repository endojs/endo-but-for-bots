#!/usr/bin/env bash
# Reproduce the full local demonstration (milestones 1 & 2) and capture every
# transcript under demo/transcripts/. Run from the package root or anywhere.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$(cd "$here/.." && pwd)"
out="$here/transcripts"
mkdir -p "$out"
cd "$pkg"
export TMPDIR="${TMPDIR:-/tmp}"

pass=0 fail=0
run() { # name -- command...
  local name="$1"; shift
  echo "########## $name ##########"
  if "$@" > "$out/$name.log" 2>&1; then
    echo "  PASS -> demo/transcripts/$name.log"; pass=$((pass+1))
  else
    echo "  FAIL -> demo/transcripts/$name.log"; fail=$((fail+1))
  fi
}

# Milestone 1: two-process capability round-trip over each transport.
run m1-ws-capability-roundtrip  bash demo/run-local-pair.sh ws Alice
run m1-tcp-capability-roundtrip bash demo/run-local-pair.sh tcp Bob

# Milestone 2: crossed hellos + reverse peer auth over each transport.
run m2-ws-scenarios  node demo/scenarios.mjs ws
run m2-tcp-scenarios node demo/scenarios.mjs tcp

echo
echo "SUMMARY: $pass passed, $fail failed. Transcripts in demo/transcripts/"
exit $(( fail > 0 ? 1 : 0 ))
