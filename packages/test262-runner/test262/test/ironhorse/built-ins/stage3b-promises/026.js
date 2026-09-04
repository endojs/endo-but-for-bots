/*---
description: stage3b-promises corpus line 26 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-promises.js line 26.
  Source: var x = 0; Promise.reject(2).catch(function(e){ return e + 1; }).then(function(v){ x = v; }); x
---*/
var x = 0; Promise.reject(2).catch(function(e){ return e + 1; }).then(function(v){ x = v; }); x
