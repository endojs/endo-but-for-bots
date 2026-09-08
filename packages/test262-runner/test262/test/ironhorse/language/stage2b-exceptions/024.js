/*---
description: stage2b-exceptions corpus line 24 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-exceptions.js line 24.
  Source: function f() { throw 42 } f()
---*/
var ironhorseDidThrow = false;
try {
  function f() { throw 42 } f()
} catch (ironhorseThrown) {
  ironhorseDidThrow = true;
  assert.sameValue(String(ironhorseThrown), "42");
}
assert.sameValue(ironhorseDidThrow, true);
