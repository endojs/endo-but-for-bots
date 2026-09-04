/*---
description: stage3b-object-statics corpus line 24 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-object-statics.js line 24.
  Source: var o={a:1}; var d=Object.getOwnPropertyDescriptor(o,"a"); var s=""; s+=d.value; s+=d.writable; s+=d.enumerable; s+=d.configurable; s;
---*/
var o={a:1}; var d=Object.getOwnPropertyDescriptor(o,"a"); var s=""; s+=d.value; s+=d.writable; s+=d.enumerable; s+=d.configurable; s;
