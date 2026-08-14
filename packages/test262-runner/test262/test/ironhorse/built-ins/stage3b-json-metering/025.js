/*---
description: stage3b-json-metering corpus line 25 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 25.
  Source: JSON.stringify({a:1,b:{c:2}})
---*/
assert.sameValue((JSON.stringify({a:1,b:{c:2}})), "{\"a\":1,\"b\":{\"c\":2}}");
