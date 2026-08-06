/*---
description: stage3-collections corpus line 105 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 105.
  Source: var s=new Set(); for(var i=0;i<20;i++){s.add(i);} s.clear(); var t=0; for(var x of s){t=t+1;} t
---*/
var s=new Set(); for(var i=0;i<20;i++){s.add(i);} s.clear(); var t=0; for(var x of s){t=t+1;} t
