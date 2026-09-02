/*---
description: stage3-collections corpus line 74 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 74.
  Source: var s=new Set(); s.add(1); s.add(2); s.add(3); var r=0; s.forEach(function(v){r+=v;}); r
---*/
var s=new Set(); s.add(1); s.add(2); s.add(3); var r=0; s.forEach(function(v){r+=v;}); r
