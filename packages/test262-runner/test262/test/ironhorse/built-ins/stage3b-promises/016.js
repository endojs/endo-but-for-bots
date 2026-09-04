/*---
description: stage3b-promises corpus line 16 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-promises.js line 16.
  Source: var x = 5; var p4 = new Promise(function(res){ res(3); }); p4.then(function(v){ x = v; }); x
---*/
var x = 5; var p4 = new Promise(function(res){ res(3); }); p4.then(function(v){ x = v; }); x
