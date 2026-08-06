/*---
description: stage4-new-target corpus line 13 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-new-target.js line 13.
  Source: function F(){ return new.target === F; } F();
---*/
function F(){ return new.target === F; } F();
