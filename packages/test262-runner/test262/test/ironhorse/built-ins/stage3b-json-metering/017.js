/*---
description: stage3b-json-metering corpus line 17 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 17.
  Source: JSON.stringify([undefined,null,1])
---*/
assert.sameValue((JSON.stringify([undefined,null,1])), "[null,null,1]");
