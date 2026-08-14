/*---
description: control-flow corpus line 6 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/control-flow.js line 6.
  Source: 5 > 3 ? 5 - 3 : 3 - 5
---*/
assert.sameValue((5 > 3 ? 5 - 3 : 3 - 5), 2);
