/*---
description: stage3-collections corpus line 110 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 110.
  Source: var s=new Set(); s.add(1); s.add(2); s.add(3); var a=[...s]; a[0]+a[1]+a[2]
---*/
var s=new Set(); s.add(1); s.add(2); s.add(3); var a=[...s]; a[0]+a[1]+a[2]
