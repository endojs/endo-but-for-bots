/*---
description: >
  Work just inside each resource ceiling completes identically under both
  Ironhorse resource-limit policies and on XS.
flags: [noXs, noSesNode, noSesXs, noSesIronhorse]
---*/
const nest = depth => (depth > 0 ? [depth].map(() => nest(depth - 1))[0] + 1 : 0);
assert.sameValue(nest(40), 40);
const subject = 'ab'.repeat(20000);
assert.sameValue(/(?:a|b)*$/.exec(subject)[0].length, subject.length);
