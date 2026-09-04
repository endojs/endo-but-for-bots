/*---
description: stage4-harden corpus line 20 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage4-harden.js line 20.
  Source: var s={x:1}; var o={p:s,q:s}; harden(o); Object.isFrozen(o.p)
---*/
var s={x:1}; var o={p:s,q:s}; harden(o); Object.isFrozen(o.p)
