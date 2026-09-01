/*---
description: stage3b-promises corpus line 24 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-promises.js line 24.
  Source: var x = 0; Promise.reject(7).catch(function(e){ x = e; }); x
---*/
var x = 0; Promise.reject(7).catch(function(e){ x = e; }); x
