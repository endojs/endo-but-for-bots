/*---
description: stage2b-closures corpus line 4 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-closures.js line 4.
  Source: var mk=function(n){return function(){n=n+1; return n}}; var g=mk(10); g(); g()
---*/
var mk=function(n){return function(){n=n+1; return n}}; var g=mk(10); g(); g()
