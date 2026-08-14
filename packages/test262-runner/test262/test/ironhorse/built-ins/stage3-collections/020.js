/*---
description: stage3-collections corpus line 20 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 20.
  Source: var m=new Map(); for(var i=0;i<50;i++){m.set(i,i+1);} m.get(49)
---*/
var m=new Map(); for(var i=0;i<50;i++){m.set(i,i+1);} m.get(49)
