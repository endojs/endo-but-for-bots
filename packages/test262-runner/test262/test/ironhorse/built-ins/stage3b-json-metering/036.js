/*---
description: stage3b-json-metering corpus line 36 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 36.
  Source: JSON.parse("1e3")
---*/
assert.sameValue((JSON.parse("1e3")), 1000);
