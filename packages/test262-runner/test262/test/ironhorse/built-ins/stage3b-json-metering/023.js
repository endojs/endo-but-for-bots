/*---
description: stage3b-json-metering corpus line 23 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 23.
  Source: JSON.stringify({a:{b:1}})
---*/
assert.sameValue((JSON.stringify({a:{b:1}})), "{\"a\":{\"b\":1}}");
