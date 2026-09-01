/*---
description: stage4-async-promises corpus line 11 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-async-promises.js line 11.
  Source: var x=0; Promise.resolve({then:function(res,rej){rej(9);res(7)}}).then(function(v){x=v},function(e){x=e}); x
---*/
var x=0; Promise.resolve({then:function(res,rej){rej(9);res(7)}}).then(function(v){x=v},function(e){x=e}); x
