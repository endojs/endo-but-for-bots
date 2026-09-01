/*---
description: stage3-string corpus line 58 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-string.js line 58.
  Source: "  hi  ".trimStart()
---*/
assert.sameValue(("  hi  ".trimStart()), "hi  ");
