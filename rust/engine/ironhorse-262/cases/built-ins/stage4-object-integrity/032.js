/*---
description: stage4-object-integrity corpus line 32 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-object-integrity.js line 32.
  Source: var o={a:1}; Object.freeze(o); o.b=5; typeof o.b;
---*/
var o={a:1}; Object.freeze(o); o.b=5; typeof o.b;
