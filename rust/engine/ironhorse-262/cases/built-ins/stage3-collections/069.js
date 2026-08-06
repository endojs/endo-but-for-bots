/*---
description: stage3-collections corpus line 69 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-collections.js line 69.
  Source: var m=new Map(); m.set("a",1); m.set("b",2); var ks=""; m.forEach(function(v,k){ks+=k;}); ks
---*/
var m=new Map(); m.set("a",1); m.set("b",2); var ks=""; m.forEach(function(v,k){ks+=k;}); ks
