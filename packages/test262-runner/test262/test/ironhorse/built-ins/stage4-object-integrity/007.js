/*---
description: stage4-object-integrity corpus line 7 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-object-integrity.js line 7.
  Source: var o={a:1}; Object.preventExtensions(o); o.a=9; o.a;
---*/
var o={a:1}; Object.preventExtensions(o); o.a=9; o.a;
