/*---
description: stage4-async-await corpus line 13 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-async-await.js line 13.
  Source: var p; async function f(){ return await { then: function(r){ r(9); } }; } p=f(); 0
---*/
var p; async function f(){ return await { then: function(r){ r(9); } }; } p=f(); 0
