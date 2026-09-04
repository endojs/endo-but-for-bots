/*---
description: stage3b-regexp corpus line 13 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 13.
  Source: new RegExp("").source
---*/
assert.sameValue((new RegExp("").source), "(?:)");
