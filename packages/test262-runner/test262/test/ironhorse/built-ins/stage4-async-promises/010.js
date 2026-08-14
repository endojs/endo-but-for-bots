/*---
description: stage4-async-promises corpus line 10 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-async-promises.js line 10.
  Source: var x=0; Promise.resolve({then:function(res,rej){res(7);rej(9)}}).then(function(v){x=v},function(e){x=e}); x
---*/
var x=0; Promise.resolve({then:function(res,rej){res(7);rej(9)}}).then(function(v){x=v},function(e){x=e}); x
