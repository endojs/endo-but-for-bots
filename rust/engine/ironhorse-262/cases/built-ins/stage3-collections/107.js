/*---
description: stage3-collections corpus line 107 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 107.
  Source: var a={}; var m=new Map(); m.set(a,7); var it=m.keys(); it.next().value===a
---*/
var a={}; var m=new Map(); m.set(a,7); var it=m.keys(); it.next().value===a
