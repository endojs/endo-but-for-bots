/*---
description: stage2b-closures corpus line 8 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-closures.js line 8.
  Source: var counter=function(){var n=0; return function(){return n=n+1}}; var c1=counter(),c2=counter(); c1(); c1(); c2()
---*/
var counter=function(){var n=0; return function(){return n=n+1}}; var c1=counter(),c2=counter(); c1(); c1(); c2()
