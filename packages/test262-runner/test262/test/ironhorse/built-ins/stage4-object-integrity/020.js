/*---
description: stage4-object-integrity corpus line 20 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-object-integrity.js line 20.
  Source: var o={a:1}; Object.seal(o); delete o.a; o.a;
---*/
var o={a:1}; Object.seal(o); delete o.a; o.a;
