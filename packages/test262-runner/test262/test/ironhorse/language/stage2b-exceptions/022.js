/*---
description: stage2b-exceptions corpus line 22 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-exceptions.js line 22.
  Source: try { throw 1 } finally { }
---*/
var ironhorseDidThrow = false;
try {
  try { throw 1 } finally { }
} catch (ironhorseThrown) {
  ironhorseDidThrow = true;
  assert.sameValue(String(ironhorseThrown), "1");
}
assert.sameValue(ironhorseDidThrow, true);
