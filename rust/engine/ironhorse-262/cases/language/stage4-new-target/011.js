/*---
description: stage4-new-target corpus line 11 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-new-target.js line 11.
  Source: var o; function F(){ this.k = new.target ? 7 : 0; } o = new F(); o.k;
---*/
var o; function F(){ this.k = new.target ? 7 : 0; } o = new F(); o.k;
