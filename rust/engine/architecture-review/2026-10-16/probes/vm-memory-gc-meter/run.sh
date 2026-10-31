#!/bin/bash
# usage: run.sh file.js  -> prints exit, wall seconds, peak RSS (KB), stderr (first 300 chars)
X=/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst
f=$1
start=$(date +%s.%N)
"$X" "$f" 2> ../../probes/vm-memory-gc-meter/.err &
pid=$!
peak=0
while kill -0 $pid 2>/dev/null; do
  r=$(awk '/VmHWM/{print $2}' /proc/$pid/status 2>/dev/null)
  [ -n "$r" ] && [ "$r" -gt "$peak" ] && peak=$r
  sleep 0.05
done
wait $pid; code=$?
end=$(date +%s.%N)
echo "exit=$code wall=$(echo "$end - $start" | bc) s peakRSS~=${peak}KB"
head -c 400 ../../probes/vm-memory-gc-meter/.err; echo
