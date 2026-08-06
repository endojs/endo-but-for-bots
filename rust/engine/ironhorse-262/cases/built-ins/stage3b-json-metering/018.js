/*---
description: stage3b-json-metering corpus line 18 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 18.
  Source: JSON.stringify([1,,3])
---*/
assert.sameValue((JSON.stringify([1,,3])), "[1,null,3]");
