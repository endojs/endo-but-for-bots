/*---
description: stage3-collections corpus line 109 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 109.
  Source: var m=new Map(); for(var i=0;i<5;i++)m.set(i,i*i); var t=0; m.forEach(function(v,k){t+=k;}); t
---*/
var m=new Map(); for(var i=0;i<5;i++)m.set(i,i*i); var t=0; m.forEach(function(v,k){t+=k;}); t
