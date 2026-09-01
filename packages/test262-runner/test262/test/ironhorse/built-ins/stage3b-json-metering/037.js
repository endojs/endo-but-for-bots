/*---
description: stage3b-json-metering corpus line 37 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 37.
  Source: JSON.parse("3.14159e-2")
---*/
assert.sameValue((JSON.parse("3.14159e-2")), 0.0314159);
