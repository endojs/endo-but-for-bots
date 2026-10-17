#!/bin/bash
# shellcheck disable=SC2034
# usage: t262.sh relpath-under-test/ ... ; runs non-strict with harness includes
T=/home/user/endo-but-for-bots/packages/test262-runner/test262
X=/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst
mkdir -p t262tmp
for rel in "$@"; do
  f=$T/test/$rel
  inc=$(sed -n '/\/\*---/,/---\*\//p' $f | grep -E '^\s*includes:' | sed 's/.*\[\(.*\)\].*/\1/' | tr ',' ' ')
  out=t262tmp/$(echo $rel | tr '/' '_')
  { cat $T/harness/assert.js $T/harness/sta.js; for i in $inc; do cat $T/harness/$i; done; cat $f; } > $out
  if sed -n '/\/\*---/,/---\*\//p' $f | grep -q onlyStrict; then sed -i '1i "use strict";' $out; fi
  r=$(timeout 60 $X $out 2>&1 | head -c 300); c=$?
  echo "$rel => ${r:-PASS}"
done
