/*---
description: stage4-async-await corpus line 12 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-async-await.js line 12.
  Source: var s=0; async function f(){ for (var i=0;i<3;i++){ s += await i; } } f(); s
---*/
var s=0; async function f(){ for (var i=0;i<3;i++){ s += await i; } } f(); s
