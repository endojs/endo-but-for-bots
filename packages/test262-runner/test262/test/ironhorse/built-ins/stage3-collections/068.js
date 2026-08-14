/*---
description: stage3-collections corpus line 68 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 68.
  Source: var m=new Map(); m.set(1,10); m.set(2,20); m.set(3,30); var r=0; m.forEach(function(v){r+=v;}); r
---*/
var m=new Map(); m.set(1,10); m.set(2,20); m.set(3,30); var r=0; m.forEach(function(v){r+=v;}); r
