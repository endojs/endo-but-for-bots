/*---
description: stage4-object-integrity corpus line 38 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-object-integrity.js line 38.
  Source: var o={}; Object.defineProperty(o,"x",{value:1,writable:true,enumerable:true,configurable:false}); Object.preventExtensions(o); Object.isSealed(o) && !Object.isFrozen(o);
---*/
var o={}; Object.defineProperty(o,"x",{value:1,writable:true,enumerable:true,configurable:false}); Object.preventExtensions(o); Object.isSealed(o) && !Object.isFrozen(o);
