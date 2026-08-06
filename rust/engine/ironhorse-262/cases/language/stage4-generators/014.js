/*---
description: stage4-generators corpus line 14 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-generators.js line 14.
  Source: function* g(){ yield 1; yield 2; yield 3; } var a=[...g()]; a.length + ":" + a.join("-");
---*/
function* g(){ yield 1; yield 2; yield 3; } var a=[...g()]; a.length + ":" + a.join("-");
