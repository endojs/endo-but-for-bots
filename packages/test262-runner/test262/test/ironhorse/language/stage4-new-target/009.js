/*---
description: stage4-new-target corpus line 9 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-new-target.js line 9.
  Source: var o; function F(){ if (new.target === undefined) { return 99; } this.x = 7; } o = new F(); o.x;
---*/
var o; function F(){ if (new.target === undefined) { return 99; } this.x = 7; } o = new F(); o.x;
