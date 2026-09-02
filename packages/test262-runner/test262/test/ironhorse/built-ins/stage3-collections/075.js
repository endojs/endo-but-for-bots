/*---
description: stage3-collections corpus line 75 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 75.
  Source: var s=new Set(); s.add(4); var same=0; s.forEach(function(v,k){same=(v===k)?1:0;}); same
---*/
var s=new Set(); s.add(4); var same=0; s.forEach(function(v,k){same=(v===k)?1:0;}); same
