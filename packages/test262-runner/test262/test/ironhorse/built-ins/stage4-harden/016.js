/*---
description: stage4-harden corpus line 16 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage4-harden.js line 16.
  Source: var o={a:1,b:{c:2}}; harden(o); Object.isFrozen(o.b)
---*/
var o={a:1,b:{c:2}}; harden(o); Object.isFrozen(o.b)
