/*---
description: stage3b-json-metering corpus line 19 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 19.
  Source: JSON.stringify({a:{}})
---*/
assert.sameValue((JSON.stringify({a:{}})), "{\"a\":{}}");
