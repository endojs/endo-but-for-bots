/*---
description: stage3-collections corpus line 83 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 83.
  Source: var m=new Map(); m.set(1,2); m.set(3,4); m.set(5,6); var it=m.keys(); var t=0; var r=it.next(); while(!r.done){t+=r.value; r=it.next();} t
---*/
var m=new Map(); m.set(1,2); m.set(3,4); m.set(5,6); var it=m.keys(); var t=0; var r=it.next(); while(!r.done){t+=r.value; r=it.next();} t
