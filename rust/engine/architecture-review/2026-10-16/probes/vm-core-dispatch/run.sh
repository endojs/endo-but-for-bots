#!/bin/bash
# usage: run.sh file.js  -> prints ironhorse and node outcomes
f="$1"
ih=$(timeout 60 /home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst "$f" 2>&1; echo "[exit $?]")
nd=$(/opt/node22/bin/node -e 'const fs=require("fs");try{require("vm").runInThisContext(fs.readFileSync(process.argv[1],"utf8"));console.log("[completed]")}catch(e){console.log(String(e))}' "$f" 2>&1)
echo "IH:   $ih"
echo "NODE: $nd"
