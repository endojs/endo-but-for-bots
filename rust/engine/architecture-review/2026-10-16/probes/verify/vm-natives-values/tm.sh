#!/bin/bash
# usage: tm.sh file.js : wall time of IH and node
XST=/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst
s=$(date +%s.%N); out=$(TZ=UTC timeout ${T:-300} $XST "$1" 2>&1); ec=$?; e=$(date +%s.%N)
echo "IH   exit=$ec time=$(echo "$e - $s" | bc)s out=$(echo "$out"|head -c 300)"
s=$(date +%s.%N); out=$(TZ=UTC timeout 60 node "$1" 2>&1 | grep -m1 Error); ec=$?; e=$(date +%s.%N)
echo "node time=$(echo "$e - $s" | bc)s out=$(echo "$out"|head -c 300)"
