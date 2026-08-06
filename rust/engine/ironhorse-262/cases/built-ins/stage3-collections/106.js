/*---
description: stage3-collections corpus line 106 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 106.
  Source: var a={}; var b={}; var m=new Map(); m.set(a,1); m.set(b,2); var t=0; m.forEach(function(v){t+=v;}); t
---*/
var a={}; var b={}; var m=new Map(); m.set(a,1); m.set(b,2); var t=0; m.forEach(function(v){t+=v;}); t
