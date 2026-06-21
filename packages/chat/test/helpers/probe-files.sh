#!/bin/bash
# Fast diagnostic for the Node-24 chat worker hang (plain `ava` wedges on CI;
# Node 22 and the `c8 ses-ava` path both pass; the suite exits cleanly on a
# local Node 24 — pointing at a timing race that leaves a libuv handle open at
# full speed). This runs the FULL suite ONCE under worker threads, exactly as
# CI does (the real hang condition). Every worker loads `handle-dump.mjs` (via
# --import): an unref'd 120s watchdog that fires ONLY if a worker's loop is
# still held open, dumps the surviving resources/handles (to stderr and
# /tmp/handle-dump.log), and force-exits so the job concludes in minutes
# instead of hanging for hours. A hard 600s `timeout` backstops it.
set -u

PRELOAD="$PWD/test/helpers/handle-dump.mjs"
DUMP=/tmp/handle-dump.log
: >"$DUMP"

echo "[probe] full suite under worker threads, 120s per-worker watchdog"
timeout -s KILL 600 \
  ava --node-arguments="--import=$PRELOAD" 2>&1 | tail -40
echo "[probe] ava pipeline exit=${PIPESTATUS[0]}"

echo "[probe] ===== HANDLE DUMP (stuck workers; empty = no hang reproduced) ====="
cat "$DUMP"
exit 0
