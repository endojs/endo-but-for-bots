/*---
description: stage3b-binary corpus line 59 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-binary.js line 59.
  Source: var d3 = new DataView(new ArrayBuffer(8)); d3.setInt16(0, 12345); d3.getInt16(0)
---*/
var d3 = new DataView(new ArrayBuffer(8)); d3.setInt16(0, 12345); d3.getInt16(0)
