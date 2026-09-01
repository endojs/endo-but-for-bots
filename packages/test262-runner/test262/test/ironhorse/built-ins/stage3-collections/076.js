/*---
description: stage3-collections corpus line 76 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 76.
  Source: var s=new Set(); s.add(2); var self=0; s.forEach(function(v,k,ss){self=(ss===s)?1:0;}); self
---*/
var s=new Set(); s.add(2); var self=0; s.forEach(function(v,k,ss){self=(ss===s)?1:0;}); self
