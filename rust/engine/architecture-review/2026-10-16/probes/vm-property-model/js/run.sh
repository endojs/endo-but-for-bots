#!/bin/bash
# usage: run.sh file.js ...  -> ironhorse vs node: exit, time, first error line
X=/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst
N=/opt/node22/bin/node
for f in "$@"; do
  echo "== $f"
  s=$(date +%s%N); out=$(timeout 300 $X "$f" 2>&1); code=$?; e=$(date +%s%N)
  printf 'ih  (exit=%s, %dms): %s\n' "$code" "$(( (e-s)/1000000 ))" "$(echo "$out" | head -c 1500)"
  s=$(date +%s%N); out=$(timeout 300 $N "$f" 2>&1 | grep -E '^[A-Za-z]*Error' | head -1); e=$(date +%s%N)
  printf 'node(%dms): %s\n' "$(( (e-s)/1000000 ))" "$(echo "$out" | head -c 1500)"
done
