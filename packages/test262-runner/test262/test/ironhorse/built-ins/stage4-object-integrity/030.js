/*---
description: stage4-object-integrity corpus line 30 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-object-integrity.js line 30.
  Source: var o={a:1}; Object.freeze(o); o.a=2; o.a;
---*/
var o={a:1}; Object.freeze(o); o.a=2; o.a;
