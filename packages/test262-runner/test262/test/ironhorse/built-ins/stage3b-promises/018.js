/*---
description: stage3b-promises corpus line 18 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-promises.js line 18.
  Source: var x = 0; Promise.resolve(1).then(function(v){ return v + 1; }).then(function(v){ x = v; }); x
---*/
var x = 0; Promise.resolve(1).then(function(v){ return v + 1; }).then(function(v){ x = v; }); x
