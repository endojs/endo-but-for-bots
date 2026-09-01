/*---
description: stage3b-json-metering corpus line 7 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 7.
  Source: JSON.stringify({t:true,f:false,n:null})
---*/
assert.sameValue((JSON.stringify({t:true,f:false,n:null})), "{\"t\":true,\"f\":false,\"n\":null}");
