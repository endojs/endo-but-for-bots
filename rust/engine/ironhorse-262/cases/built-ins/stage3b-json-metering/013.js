/*---
description: stage3b-json-metering corpus line 13 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 13.
  Source: JSON.stringify(["a","bb","ccc"])
---*/
assert.sameValue((JSON.stringify(["a","bb","ccc"])), "[\"a\",\"bb\",\"ccc\"]");
