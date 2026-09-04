/*---
description: stage4-harden corpus line 25 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage4-harden.js line 25.
  Source: var o={a:1,b:{c:2}}; petrify(o); o.b.c=9; o.b.c
---*/
var o={a:1,b:{c:2}}; petrify(o); o.b.c=9; o.b.c
