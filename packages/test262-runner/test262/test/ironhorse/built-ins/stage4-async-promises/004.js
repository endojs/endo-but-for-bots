/*---
description: stage4-async-promises corpus line 4 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-async-promises.js line 4.
  Source: var x=0; Promise.resolve({then:function(res,rej){rej(3)}}).then(function(v){x=1},function(e){x=e}); x
---*/
var x=0; Promise.resolve({then:function(res,rej){rej(3)}}).then(function(v){x=1},function(e){x=e}); x
