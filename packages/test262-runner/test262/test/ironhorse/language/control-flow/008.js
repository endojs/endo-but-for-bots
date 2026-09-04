/*---
description: control-flow corpus line 8 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/control-flow.js line 8.
  Source: (0 || 5) ? 100 : 200
---*/
assert.sameValue(((0 || 5) ? 100 : 200), 100);
