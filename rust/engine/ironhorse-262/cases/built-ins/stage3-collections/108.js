/*---
description: stage3-collections corpus line 108 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 108.
  Source: var m=new Map(); m.set(1,2); m.set(3,4); var it=m.entries(); var e1=it.next().value; var e2=it.next().value; e1[0]+e2[1]
---*/
var m=new Map(); m.set(1,2); m.set(3,4); var it=m.entries(); var e1=it.next().value; var e2=it.next().value; e1[0]+e2[1]
