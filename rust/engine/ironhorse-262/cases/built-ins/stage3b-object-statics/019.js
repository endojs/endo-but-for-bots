/*---
description: stage3b-object-statics corpus line 19 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-object-statics.js line 19.
  Source: var o = {p:1, q:2}; Object.keys(o).length === 2 && o.hasOwnProperty("p");
---*/
var o = {p:1, q:2}; Object.keys(o).length === 2 && o.hasOwnProperty("p");
