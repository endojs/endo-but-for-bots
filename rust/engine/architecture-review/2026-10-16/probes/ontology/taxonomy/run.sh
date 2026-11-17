#!/bin/bash
# usage: run.sh file.js ...
IH=/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst
for f in "$@"; do
  echo "=== $f"
  echo "--- ironhorse:"; timeout 60 $IH "$f" 2>&1 | head -c 600; echo " [exit ${PIPESTATUS[0]}]"
  echo "--- node:"; timeout 60 /opt/node22/bin/node "$f" 2>&1 | grep -v "^\s*at \|^$\|^Node.js\|^\s*\^\|throw new" | head -c 400; echo " [exit ${PIPESTATUS[0]}]"
done
