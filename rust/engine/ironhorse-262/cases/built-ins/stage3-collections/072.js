/*---
description: stage3-collections corpus line 72 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 72.
  Source: var m=new Map(); m.set(1,5); var t={n:100}; var got=0; m.forEach(function(v){got=this.n;},t); got
---*/
var m=new Map(); m.set(1,5); var t={n:100}; var got=0; m.forEach(function(v){got=this.n;},t); got
