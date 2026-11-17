/*---
description: >
  Nested callbacks deeper than Ironhorse's native re-entry budget. XS
  completes them. Ironhorse under the default `panic` resource-limit policy
  stops the case uncatchably; under `throw` the guest catches a `RangeError`
  and the next call starts from a released budget.
flags: [noXs, noSesNode, noSesXs, noSesIronhorse]
---*/
const nest = depth => {
  if (depth > 0) {
    [0].forEach(() => nest(depth - 1));
  }
};
let caught;
try {
  nest(100);
} catch (error) {
  caught = error;
}
if (caught !== undefined) {
  assert(caught instanceof RangeError, 'the ceiling raises a RangeError');
  assert.sameValue(
    caught.message,
    'resource limit: native recursion depth exceeded',
  );
}
nest(20);
