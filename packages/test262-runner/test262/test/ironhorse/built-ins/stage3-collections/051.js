/*---
description: stage3-collections corpus line 51 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 51.
  Source: var s=new Set(); for(var i=0;i<10;i++){s.add(i);} s.delete(5); s.has(5)
---*/
var s=new Set(); for(var i=0;i<10;i++){s.add(i);} s.delete(5); s.has(5)
