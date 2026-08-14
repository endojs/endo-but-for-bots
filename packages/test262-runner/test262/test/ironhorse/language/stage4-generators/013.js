/*---
description: stage4-generators corpus line 13 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-generators.js line 13.
  Source: function* count(n){ var i=0; while(i<n) yield i++; } var s=0; for (var v of count(4)) s+=v; s;
---*/
function* count(n){ var i=0; while(i<n) yield i++; } var s=0; for (var v of count(4)) s+=v; s;
