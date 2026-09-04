/*---
description: stage3b-json-metering corpus line 6 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 6.
  Source: JSON.stringify({name:"John",age:30})
---*/
assert.sameValue((JSON.stringify({name:"John",age:30})), "{\"name\":\"John\",\"age\":30}");
