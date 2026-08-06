/*---
description: stage4-async-await corpus line 9 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-async-await.js line 9.
  Source: var p; async function g(){ return 3; } async function f(){ return await g(); } p=f(); 0
---*/
var p; async function g(){ return 3; } async function f(){ return await g(); } p=f(); 0
