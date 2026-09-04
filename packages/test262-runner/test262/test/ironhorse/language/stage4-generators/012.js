/*---
description: stage4-generators corpus line 12 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-generators.js line 12.
  Source: function* g(){ for (var i=0;i<3;i++) yield i*i; } var s=0; for (var v of g()) s+=v; s;
---*/
function* g(){ for (var i=0;i<3;i++) yield i*i; } var s=0; for (var v of g()) s+=v; s;
