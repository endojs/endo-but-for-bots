/*---
description: stage2b-closures corpus line 1 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-closures.js line 1.
  Source: var mk=function(){var c=0; return function(){c=c+1; return c}}; var f=mk(); f()
---*/
var mk=function(){var c=0; return function(){c=c+1; return c}}; var f=mk(); f()
