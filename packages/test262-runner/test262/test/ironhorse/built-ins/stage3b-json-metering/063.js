/*---
description: stage3b-json-metering corpus line 63 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 63.
  Source: JSON.stringify(JSON.parse("[1,2,3]"))
---*/
assert.sameValue((JSON.stringify(JSON.parse("[1,2,3]"))), "[1,2,3]");
