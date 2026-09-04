/*---
description: stage3b-object-statics corpus line 29 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-object-statics.js line 29.
  Source: var o={k:42}; var d=Object.getOwnPropertyDescriptor(o,"k"); o.hasOwnProperty("k") && d.enumerable && d.configurable && d.writable;
---*/
var o={k:42}; var d=Object.getOwnPropertyDescriptor(o,"k"); o.hasOwnProperty("k") && d.enumerable && d.configurable && d.writable;
