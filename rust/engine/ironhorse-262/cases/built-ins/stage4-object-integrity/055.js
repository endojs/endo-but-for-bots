/*---
description: stage4-object-integrity corpus line 55 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-object-integrity.js line 55.
  Source: var o={}; Object.defineProperty(o,"x",{value:7,writable:false,enumerable:true,configurable:false}); var d=Object.getOwnPropertyDescriptors(o); d.x.writable===false && d.x.configurable===false;
---*/
var o={}; Object.defineProperty(o,"x",{value:7,writable:false,enumerable:true,configurable:false}); var d=Object.getOwnPropertyDescriptors(o); d.x.writable===false && d.x.configurable===false;
