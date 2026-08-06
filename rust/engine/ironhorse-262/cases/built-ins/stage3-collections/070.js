/*---
description: stage3-collections corpus line 70 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 70.
  Source: var m=new Map(); m.set(1,2); var self=0; m.forEach(function(v,k,mm){self=(mm===m)?1:0;}); self
---*/
var m=new Map(); m.set(1,2); var self=0; m.forEach(function(v,k,mm){self=(mm===m)?1:0;}); self
