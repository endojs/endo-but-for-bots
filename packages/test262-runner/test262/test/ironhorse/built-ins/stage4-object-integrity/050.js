/*---
description: stage4-object-integrity corpus line 50 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-object-integrity.js line 50.
  Source: var o={a:1}; Object.defineProperty(o,"h",{value:9,writable:true,enumerable:false,configurable:true}); Object.entries(o).length;
---*/
var o={a:1}; Object.defineProperty(o,"h",{value:9,writable:true,enumerable:false,configurable:true}); Object.entries(o).length;
