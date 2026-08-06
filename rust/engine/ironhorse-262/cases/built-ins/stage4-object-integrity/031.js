/*---
description: stage4-object-integrity corpus line 31 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-object-integrity.js line 31.
  Source: var o={a:1,b:2}; Object.freeze(o); o.a=9; o.b=9; o.a+o.b;
---*/
var o={a:1,b:2}; Object.freeze(o); o.a=9; o.b=9; o.a+o.b;
