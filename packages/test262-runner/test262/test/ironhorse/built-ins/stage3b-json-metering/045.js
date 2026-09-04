/*---
description: stage3b-json-metering corpus line 45 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 45.
  Source: JSON.parse("\"\\u0041\\u00e9\"")
---*/
assert.sameValue((JSON.parse("\"\\u0041\\u00e9\"")), "Aé");
