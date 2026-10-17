#!/bin/bash
f=$1
echo "== ironhorse: $f"
s=$(date +%s.%N)
out=$(timeout ${T:-120} /home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst $f 2>&1); rc=$?
e=$(date +%s.%N)
echo "$out" | tail -2
echo "  exit=$rc wall=$(echo "$e - $s" | bc)s"
echo "== node: $f"
s=$(date +%s.%N)
out=$(timeout 120 /opt/node22/bin/node $f 2>&1)
e=$(date +%s.%N)
echo "$out" | grep -E '^[A-Za-z]*Error' | head -1
echo "  wall=$(echo "$e - $s" | bc)s"
