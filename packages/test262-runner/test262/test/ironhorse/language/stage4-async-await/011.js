/*---
description: stage4-async-await corpus line 11 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-async-await.js line 11.
  Source: var p; async function f(){ await Promise.reject(1); } p=f(); 0
---*/
var p; async function f(){ await Promise.reject(1); } p=f(); 0
