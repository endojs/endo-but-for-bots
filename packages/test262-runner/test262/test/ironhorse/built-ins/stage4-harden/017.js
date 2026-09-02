/*---
description: stage4-harden corpus line 17 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage4-harden.js line 17.
  Source: var o={a:1,b:{c:2}}; harden(o); o.b.c=9; o.b.c
---*/
var o={a:1,b:{c:2}}; harden(o); o.b.c=9; o.b.c
