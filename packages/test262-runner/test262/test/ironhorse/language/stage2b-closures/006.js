/*---
description: stage2b-closures corpus line 6 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-closures.js line 6.
  Source: var mk=function(){var a=0,b=0; return function(){a=a+1; b=b+2; return a+b}}; var f=mk(); f(); f()
---*/
var mk=function(){var a=0,b=0; return function(){a=a+1; b=b+2; return a+b}}; var f=mk(); f(); f()
