/*---
description: stage3b-json-metering corpus line 16 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 16.
  Source: JSON.stringify({a:1,b:undefined,c:3})
---*/
assert.sameValue((JSON.stringify({a:1,b:undefined,c:3})), "{\"a\":1,\"c\":3}");
