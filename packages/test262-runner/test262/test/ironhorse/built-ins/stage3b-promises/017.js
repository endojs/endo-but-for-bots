/*---
description: stage3b-promises corpus line 17 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-promises.js line 17.
  Source: var x = 0; var r; new Promise(function(res){ r = res; }).then(function(v){ x = v; }); r(9); x
---*/
var x = 0; var r; new Promise(function(res){ r = res; }).then(function(v){ x = v; }); r(9); x
