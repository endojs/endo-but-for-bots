/*---
description: stage4-async-promises corpus line 6 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-async-promises.js line 6.
  Source: var x=0; Promise.resolve({then:5}).then(function(v){x=1}); x
---*/
var x=0; Promise.resolve({then:5}).then(function(v){x=1}); x
