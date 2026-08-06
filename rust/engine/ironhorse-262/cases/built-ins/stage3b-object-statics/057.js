/*---
description: stage3b-object-statics corpus line 57 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-object-statics.js line 57.
  Source: var o={}; Object.defineProperty(o,"x",{value:7,writable:true,enumerable:true,configurable:true}); var d=Object.getOwnPropertyDescriptor(o,"x"); d.value;
---*/
var o={}; Object.defineProperty(o,"x",{value:7,writable:true,enumerable:true,configurable:true}); var d=Object.getOwnPropertyDescriptor(o,"x"); d.value;
