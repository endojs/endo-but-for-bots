/*---
description: stage4-generators corpus line 15 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-generators.js line 15.
  Source: var g = function*(){ yield 5; yield 6; }; var a=g(); a.next().value + a.next().value;
---*/
var g = function*(){ yield 5; yield 6; }; var a=g(); a.next().value + a.next().value;
