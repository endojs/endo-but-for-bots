/*---
description: stage4-object-integrity corpus line 59 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-object-integrity.js line 59.
  Source: var o={a:1}; Object.defineProperty(o,"h",{value:9,writable:true,enumerable:false,configurable:true}); o.propertyIsEnumerable("h");
---*/
var o={a:1}; Object.defineProperty(o,"h",{value:9,writable:true,enumerable:false,configurable:true}); o.propertyIsEnumerable("h");
