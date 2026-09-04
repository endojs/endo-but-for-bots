/*---
description: stage3b-json-metering corpus line 27 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 27.
  Source: JSON.stringify({x:[1,{y:2}],z:"hi"})
---*/
assert.sameValue((JSON.stringify({x:[1,{y:2}],z:"hi"})), "{\"x\":[1,{\"y\":2}],\"z\":\"hi\"}");
