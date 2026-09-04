/*---
description: stage2b-closures corpus line 9 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-closures.js line 9.
  Source: var adder=function(x){return function(y){return function(z){return x+y+z}}}; adder(1)(2)(3)
---*/
var adder=function(x){return function(y){return function(z){return x+y+z}}}; adder(1)(2)(3)
