/*---
description: stage3b-json-metering corpus line 33 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 33.
  Source: JSON.parse("-42")
---*/
assert.sameValue((JSON.parse("-42")), -42);
