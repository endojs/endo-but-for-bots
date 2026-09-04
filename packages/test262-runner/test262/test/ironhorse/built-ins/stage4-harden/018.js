/*---
description: stage4-harden corpus line 18 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage4-harden.js line 18.
  Source: var o={a:{b:{c:3}}}; harden(o); Object.isFrozen(o.a.b)
---*/
var o={a:{b:{c:3}}}; harden(o); Object.isFrozen(o.a.b)
