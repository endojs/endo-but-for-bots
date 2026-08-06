/*---
description: stage3-collections corpus line 88 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 88.
  Source: var s=new Set(); s.add(1); s.add(2); var it=s.values(); it.next(); it.next().done
---*/
var s=new Set(); s.add(1); s.add(2); var it=s.values(); it.next(); it.next().done
