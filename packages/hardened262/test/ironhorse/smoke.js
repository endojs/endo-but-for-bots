/*---
flags: [noXs, noSesNode, noSesXs]
---*/
// The Ironhorse deliveries' smoke test: not a raw no-op expression but a real
// harness assertion, so it exercises the whole adapter path end to end — the
// assembled `sta.js`/`assert.js` prelude (including the Ironhorse-only
// `Test262Error.prototype.toString` substitution) and a `Test262Error` that a
// broken engine would actually throw. `assert.sameValue(2 + 2, 4)` passes only
// when the subject evaluates arithmetic and the harness's assertion protocol
// reaches the engine.
assert.sameValue(2 + 2, 4);
