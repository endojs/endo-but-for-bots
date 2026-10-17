#!/bin/sh
# usage: run.sh probe.js -- prepends lib.js, runs in ironhorse-xst and in node (as a classic script)
P=$(dirname "$0")
f="$1"
t=$(mktemp -p "$P" .tmpXXXX.js)
cat "$P/lib.js" "$f" > "$t"
IH=/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst
echo "== $(basename $f)"
printf "ironhorse: "; timeout 120 $IH -s "$t" 2>&1 | head -c 1500; echo
printf "node:      "; timeout 120 /opt/node22/bin/node -e "require('vm').runInThisContext(require('fs').readFileSync(process.argv[1],'utf8'),{filename:'probe.js'})" "$t" 2>&1 | grep -E '^[A-Za-z]*Error' | head -2 | head -c 1500; echo
rm -f "$t"
