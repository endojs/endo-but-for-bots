/*---
description: stage3-json corpus line 12 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-json.js line 12.
  Source: JSON.stringify("tab\tnewline\nreturn\r")
---*/
assert.sameValue((JSON.stringify("tab\tnewline\nreturn\r")), "\"tab\\tnewline\\nreturn\\r\"");
