/*---
description: stage3b-json-metering corpus line 15 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 15.
  Source: JSON.stringify({a:undefined})
---*/
assert.sameValue((JSON.stringify({a:undefined})), "{}");
