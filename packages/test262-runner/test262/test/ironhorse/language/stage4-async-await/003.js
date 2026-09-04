/*---
description: stage4-async-await corpus line 3 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-async-await.js line 3.
  Source: var log=""; async function f(){ log+="1"; await 0; log+="2"; await 0; log+="3"; } f(); log+="!"; log
---*/
var log=""; async function f(){ log+="1"; await 0; log+="2"; await 0; log+="3"; } f(); log+="!"; log
