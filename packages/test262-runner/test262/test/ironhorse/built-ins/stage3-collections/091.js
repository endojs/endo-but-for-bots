/*---
description: stage3-collections corpus line 91 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 91.
  Source: var m=new Map(); m.set(1,10); m.set(2,20); var t=0; for(var e of m){t+=e[0];} t
---*/
var m=new Map(); m.set(1,10); m.set(2,20); var t=0; for(var e of m){t+=e[0];} t
