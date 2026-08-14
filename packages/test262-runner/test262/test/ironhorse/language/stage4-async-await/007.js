/*---
description: stage4-async-await corpus line 7 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-async-await.js line 7.
  Source: var p; async function f(){ var y = await Promise.resolve(7); return y; } p=f(); 0
---*/
var p; async function f(){ var y = await Promise.resolve(7); return y; } p=f(); 0
