/*---
description: stage4-object-integrity corpus line 34 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-object-integrity.js line 34.
  Source: var o={a:1}; Object.freeze(o); var d=Object.getOwnPropertyDescriptor(o,"a"); d.writable===false && d.configurable===false && d.enumerable===true;
---*/
var o={a:1}; Object.freeze(o); var d=Object.getOwnPropertyDescriptor(o,"a"); d.writable===false && d.configurable===false && d.enumerable===true;
