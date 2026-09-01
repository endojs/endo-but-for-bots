/*---
description: stage4-object-integrity corpus line 60 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-object-integrity.js line 60.
  Source: var o={a:1}; Object.defineProperty(o,"e",{value:9,writable:true,enumerable:true,configurable:true}); o.propertyIsEnumerable("e");
---*/
var o={a:1}; Object.defineProperty(o,"e",{value:9,writable:true,enumerable:true,configurable:true}); o.propertyIsEnumerable("e");
