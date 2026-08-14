/*---
description: stage3-json corpus line 13 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-json.js line 13.
  Source: JSON.stringify("bell\bform\f")
---*/
assert.sameValue((JSON.stringify("bell\bform\f")), "\"bell\\bform\\f\"");
