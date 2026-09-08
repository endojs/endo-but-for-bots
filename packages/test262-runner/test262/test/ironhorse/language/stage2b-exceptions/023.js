/*---
description: stage2b-exceptions corpus line 23 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-exceptions.js line 23.
  Source: try { throw 2 } catch (e) { throw e + 1 }
---*/
var ironhorseDidThrow = false;
try {
  try { throw 2 } catch (e) { throw e + 1 }
} catch (ironhorseThrown) {
  ironhorseDidThrow = true;
  assert.sameValue(String(ironhorseThrown), "3");
}
assert.sameValue(ironhorseDidThrow, true);
