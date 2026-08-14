/*---
description: stage3b-object-statics corpus line 53 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-object-statics.js line 53.
  Source: var o={a:1,b:2}; Object.defineProperty(o,"c",{value:9,writable:true,enumerable:true,configurable:true}); o.c; var k=Object.keys(o); k.length;
---*/
var o={a:1,b:2}; Object.defineProperty(o,"c",{value:9,writable:true,enumerable:true,configurable:true}); o.c; var k=Object.keys(o); k.length;
