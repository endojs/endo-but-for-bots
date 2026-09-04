/*---
description: stage3b-binary corpus line 70 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-binary.js line 70.
  Source: var f1 = new DataView(new ArrayBuffer(8)); f1.setInt32(4, 777); f1.getInt32(4)
---*/
var f1 = new DataView(new ArrayBuffer(8)); f1.setInt32(4, 777); f1.getInt32(4)
