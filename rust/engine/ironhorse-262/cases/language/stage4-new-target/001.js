/*---
description: stage4-new-target corpus line 1 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-new-target.js line 1.
  Source: var t; function F(){ t = new.target; } new F(); t === F;
---*/
var t; function F(){ t = new.target; } new F(); t === F;
