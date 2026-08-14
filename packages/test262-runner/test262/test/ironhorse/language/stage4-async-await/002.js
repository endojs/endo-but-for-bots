/*---
description: stage4-async-await corpus line 2 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-async-await.js line 2.
  Source: var log=""; async function f(){ log+="a"; var y = await 10; log+="b"+y; } f(); log+="c"; log
---*/
var log=""; async function f(){ log+="a"; var y = await 10; log+="b"+y; } f(); log+="c"; log
