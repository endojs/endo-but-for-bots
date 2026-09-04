/*---
description: stage4-async-await corpus line 6 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-async-await.js line 6.
  Source: var p; async function f(){ await 1; await 1; return 5; } p=f(); 0
---*/
var p; async function f(){ await 1; await 1; return 5; } p=f(); 0
