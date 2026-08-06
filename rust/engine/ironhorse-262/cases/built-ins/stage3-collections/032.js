/*---
description: stage3-collections corpus line 32 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 32.
  Source: var m=new Map(); for(var i=0;i<10;i++){m.set(i,i);} for(var j=0;j<5;j++){m.delete(j);} m.size
---*/
var m=new Map(); for(var i=0;i<10;i++){m.set(i,i);} for(var j=0;j<5;j++){m.delete(j);} m.size
