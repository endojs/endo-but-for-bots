/*---
description: stage4-harden corpus line 19 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage4-harden.js line 19.
  Source: var o={a:{b:{c:3}}}; harden(o); o.a.b.c=9; o.a.b.c
---*/
var o={a:{b:{c:3}}}; harden(o); o.a.b.c=9; o.a.b.c
