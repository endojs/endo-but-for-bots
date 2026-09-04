/*---
description: stage2b-closures corpus line 7 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-closures.js line 7.
  Source: var out=function(){var c=5; var inc=function(){c=c+1; return c}; return inc()+inc()}; out()
---*/
var out=function(){var c=5; var inc=function(){c=c+1; return c}; return inc()+inc()}; out()
