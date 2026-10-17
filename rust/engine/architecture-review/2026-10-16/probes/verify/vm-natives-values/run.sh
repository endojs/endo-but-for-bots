#!/bin/bash
# usage: run.sh file.js  -> prints IH and node output
XST=/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst
f=$1
echo "--- IH"; ( TZ=UTC timeout ${T:-60} $XST "$f"; echo "exit=$?" ) 2>&1 | tail -c 3000
echo "--- node"; ( TZ=UTC timeout 60 node "$f"; echo "exit=$?" ) 2>&1 | grep -v '^    at \|^$\|node:internal\|^Node.js' | tail -c 3000
