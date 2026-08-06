/*---
description: stage3b-object-statics corpus line 59 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-object-statics.js line 59.
  Source: var o={}; Object.defineProperty(o,"p",{value:42,writable:false,enumerable:false,configurable:true}); var d=Object.getOwnPropertyDescriptor(o,"p"); d.value===42 && d.writable===false && d.enumerable===false && d.configurable===true;
---*/
var o={}; Object.defineProperty(o,"p",{value:42,writable:false,enumerable:false,configurable:true}); var d=Object.getOwnPropertyDescriptor(o,"p"); d.value===42 && d.writable===false && d.enumerable===false && d.configurable===true;
