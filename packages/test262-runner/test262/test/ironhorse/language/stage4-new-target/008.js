/*---
description: stage4-new-target corpus line 8 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-new-target.js line 8.
  Source: function F(){ if (new.target === undefined) { return 99; } this.x = 1; } F();
---*/
function F(){ if (new.target === undefined) { return 99; } this.x = 1; } F();
