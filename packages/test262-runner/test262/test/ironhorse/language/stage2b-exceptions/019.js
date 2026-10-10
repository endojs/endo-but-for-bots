/*---
description: stage2b-exceptions corpus line 19 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-exceptions.js line 19.
  Source: throw 7
---*/
var ironhorseDidThrow = false;
try {
  throw 7
} catch (ironhorseThrown) {
  ironhorseDidThrow = true;
  assert.sameValue(String(ironhorseThrown), "7");
}
assert.sameValue(ironhorseDidThrow, true);
