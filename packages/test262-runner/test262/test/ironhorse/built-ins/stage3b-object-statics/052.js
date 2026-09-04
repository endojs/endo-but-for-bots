/*---
description: stage3b-object-statics corpus line 52 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-object-statics.js line 52.
  Source: var o={a:1}; Object.defineProperty(o,"e",{value:9,writable:true,enumerable:true,configurable:true}); o.e; Object.keys(o).length;
---*/
var o={a:1}; Object.defineProperty(o,"e",{value:9,writable:true,enumerable:true,configurable:true}); o.e; Object.keys(o).length;
