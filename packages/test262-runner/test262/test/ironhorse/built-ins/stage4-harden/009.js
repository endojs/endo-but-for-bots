/*---
description: stage4-harden corpus line 9 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage4-harden.js line 9.
  Source: var o={a:1}; harden(o); harden(o); o.a=5; o.a
---*/
var o={a:1}; harden(o); harden(o); o.a=5; o.a
