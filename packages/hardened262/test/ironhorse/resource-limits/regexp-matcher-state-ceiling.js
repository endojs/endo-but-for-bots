/*---
description: >
  A match that retains more backtracking states than Ironhorse's matcher
  admits. XS completes it. Ironhorse under the default `panic` resource-limit
  policy stops the case uncatchably, so the `ironhorse` baseline records a
  failure; under `throw` the guest catches a `RangeError`, and the realm
  remains usable afterward.
flags: [noXs, noSesNode, noSesXs, noSesIronhorse]
---*/
const subject = 'ab'.repeat(40000);
let caught;
try {
  const match = /(?:a|b)*$/.exec(subject);
  assert.sameValue(match[0].length, subject.length);
} catch (error) {
  caught = error;
}
if (caught !== undefined) {
  assert(caught instanceof RangeError, 'the ceiling raises a RangeError');
  assert.sameValue(caught.message, 'resource limit: heap exhausted');
}
assert.sameValue(/(?:a|b)*$/.exec('ab'.repeat(100))[0].length, 200);
