/*---
description: stage4-async-promises corpus line 3 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-async-promises.js line 3.
  Source: var x=0; Promise.resolve({then:function(res){res(7)}}); x
---*/
var x=0; Promise.resolve({then:function(res){res(7)}}); x
