/*---
description: stage4-harden corpus line 24 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage4-harden.js line 24.
  Source: var o={a:1,b:2}; petrify(o); o.a=8; o.b=8; o.a+o.b
---*/
var o={a:1,b:2}; petrify(o); o.a=8; o.b=8; o.a+o.b
