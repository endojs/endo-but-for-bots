/*---
description: stage2b-closures corpus line 10 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-closures.js line 10.
  Source: var acc=function(){var s=0; return function(v){s=s+v; return s}}; var a=acc(); a(10); a(20); a(5)
---*/
var acc=function(){var s=0; return function(v){s=s+v; return s}}; var a=acc(); a(10); a(20); a(5)
