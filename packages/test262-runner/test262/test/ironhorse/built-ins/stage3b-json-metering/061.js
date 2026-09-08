/*---
description: stage3b-json-metering corpus line 61 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-2-raw-15411400, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 61.
  Source: JSON.parse("[10,20,30]").length
---*/
assert.sameValue((JSON.parse("[10,20,30]").length), 3);
