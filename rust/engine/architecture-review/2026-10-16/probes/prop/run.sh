#!/bin/bash
# usage: run.sh file.js  -> prints ironhorse and node results
X=/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst
for f in "$@"; do
  echo "== $f"
  s=$(date +%s.%N); out=$(timeout 300 $X "$f" 2>&1); code=$?; e=$(date +%s.%N)
  printf 'ironhorse(exit=%s, %.2fs): %s\n' "$code" "$(echo "$e - $s" | bc)" "$(echo "$out" | head -c 600)"
  s=$(date +%s.%N); out=$(timeout 300 /opt/node22/bin/node "$f" 2>&1 | grep -E '^[A-Za-z]*Error' | head -1); e=$(date +%s.%N)
  printf 'node(%.2fs): %s\n' "$(echo "$e - $s" | bc)" "$(echo "$out" | head -c 600)"
done
