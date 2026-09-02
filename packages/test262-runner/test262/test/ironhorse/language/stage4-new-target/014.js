/*---
description: stage4-new-target corpus line 14 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-new-target.js line 14.
  Source: var t; function make(){ function G(){ t = new.target; } return G; } var g = make(); new g(); t === g;
---*/
var t; function make(){ function G(){ t = new.target; } return G; } var g = make(); new g(); t === g;
