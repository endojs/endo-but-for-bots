/*---
description: stage4-harden corpus line 15 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage4-harden.js line 15.
  Source: var o={a:1,b:2,c:3}; harden(o); o.a=9; o.b=9; o.c=9; o.a+o.b+o.c
---*/
var o={a:1,b:2,c:3}; harden(o); o.a=9; o.b=9; o.c=9; o.a+o.b+o.c
