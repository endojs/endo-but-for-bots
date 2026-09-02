/*---
description: stage3b-json-metering corpus line 12 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 12.
  Source: JSON.stringify([true,false,null])
---*/
assert.sameValue((JSON.stringify([true,false,null])), "[true,false,null]");
