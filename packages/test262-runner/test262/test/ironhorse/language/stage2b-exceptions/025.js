/*---
description: stage2b-exceptions corpus line 25 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-exceptions.js line 25.
  Source: var o = {}; o.a = 3; throw o.a
---*/
var ironhorseDidThrow = false;
try {
  var o = {}; o.a = 3; throw o.a
} catch (ironhorseThrown) {
  ironhorseDidThrow = true;
  assert.sameValue(String(ironhorseThrown), "3");
}
assert.sameValue(ironhorseDidThrow, true);
