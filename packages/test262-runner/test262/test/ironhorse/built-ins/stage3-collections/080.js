/*---
description: stage3-collections corpus line 80 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 80.
  Source: var m=new Map(); m.set(1,2); var it=m.entries(); it.next().value[1]
---*/
var m=new Map(); m.set(1,2); var it=m.entries(); it.next().value[1]
