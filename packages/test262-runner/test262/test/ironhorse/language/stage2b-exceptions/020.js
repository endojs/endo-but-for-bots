/*---
description: stage2b-exceptions corpus line 20 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-exceptions.js line 20.
  Source: throw 1 + 2 * 3
---*/
var ironhorseDidThrow = false;
try {
  throw 1 + 2 * 3
} catch (ironhorseThrown) {
  ironhorseDidThrow = true;
  assert.sameValue(String(ironhorseThrown), "7");
}
assert.sameValue(ironhorseDidThrow, true);
