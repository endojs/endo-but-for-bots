/*---
description: stage3-collections corpus line 21 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 21.
  Source: var m=new Map(); var t=0; for(var i=0;i<20;i++){m.set(i,i);} for(var j=0;j<20;j++){t+=m.get(j);} t
---*/
var m=new Map(); var t=0; for(var i=0;i<20;i++){m.set(i,i);} for(var j=0;j<20;j++){t+=m.get(j);} t
