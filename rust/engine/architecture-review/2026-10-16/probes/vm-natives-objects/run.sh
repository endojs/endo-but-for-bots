#!/bin/sh
# usage: run.sh probe.js  -> prints node and ironhorse results
f="$1"
echo "--- node:"; /opt/node22/bin/node "$f" 2>&1 | grep -v "^    at \|^$\|^Node.js\|throw new\|^\s*\^" | head -5; 
echo "--- ironhorse:"; timeout ${T:-60} /home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst "$f" 2>&1 | head -5; echo "exit=$?"
