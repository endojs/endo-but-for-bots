/*---
description: stage3b-json-metering corpus line 11 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 11.
  Source: JSON.stringify([1,2,3])
---*/
assert.sameValue((JSON.stringify([1,2,3])), "[1,2,3]");
