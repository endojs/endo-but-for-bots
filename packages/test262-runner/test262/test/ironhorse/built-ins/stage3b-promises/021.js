/*---
description: stage3b-promises corpus line 21 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-promises.js line 21.
  Source: var x = 0; Promise.resolve(1).then(undefined, function(e){}).then(function(v){ x = v; }); x
---*/
var x = 0; Promise.resolve(1).then(undefined, function(e){}).then(function(v){ x = v; }); x
