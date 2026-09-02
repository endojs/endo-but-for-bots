/*---
description: stage4-async-promises corpus line 15 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-async-promises.js line 15.
  Source: var x=0; Promise.resolve(1).then(function(v){return v*2}).then(function(v){return v*2}).then(function(v){return v*2}).then(function(v){x=v}); x
---*/
var x=0; Promise.resolve(1).then(function(v){return v*2}).then(function(v){return v*2}).then(function(v){return v*2}).then(function(v){x=v}); x
