/*---
description: stage2b-closures corpus line 5 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-closures.js line 5.
  Source: var add=function(x){return function(y){return x+y}}; add(3)(4)
---*/
var add=function(x){return function(y){return x+y}}; add(3)(4)
