#!/bin/sh
# Run every non-async, non-module built-ins/Function/prototype/toString test262 file
# through ironhorse-xst as ONE concatenated Script (assert.js + sta.js + includes + body),
# the way test262-harness hosts assemble it. Usage: sh tostring_single_script.sh <outdir>
T=/home/user/endo-but-for-bots/rust/engine/target/test262-report/test262-src
X=/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst
OUT=${1:-.}
cd "$T" || exit 1
pass=0; fail=0
for f in test/built-ins/Function/prototype/toString/*.js; do
  inc=$(grep -oE "includes: *\[[^]]*\]" "$f" | sed 's/includes: *\[//; s/\]//; s/,/ /g')
  flags=$(grep -oE "flags: *\[[^]]*\]" "$f")
  if echo "$flags" | grep -q -E "async|module|raw"; then continue; fi
  strict=""; if echo "$flags" | grep -q onlyStrict; then strict='"use strict";'; fi
  { echo "$strict"; cat harness/assert.js harness/sta.js; for i in $inc; do cat "harness/$i"; done; cat "$f"; } > "$OUT/t.js"
  if timeout 20 "$X" "$OUT/t.js" >/dev/null 2>"$OUT/err.txt"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $f: $(head -c 150 "$OUT/err.txt")"; fi
done
echo "pass=$pass fail=$fail"
