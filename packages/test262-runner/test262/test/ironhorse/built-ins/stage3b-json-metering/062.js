/*---
description: stage3b-json-metering corpus line 62 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 62.
  Source: JSON.parse("{\"x\":42}").x
---*/
assert.sameValue((JSON.parse("{\"x\":42}").x), 42);
