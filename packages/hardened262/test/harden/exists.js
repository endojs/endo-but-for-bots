/*---
flags: [onlyLockdown]
---*/
// The `harden` global exists, is callable, returns the object it is given, and
// leaves that object frozen. The smoke test the rest of the suite presumes;
// distinct from property.js (which pins transitive freezing across a property
// edge), which this file previously duplicated byte-for-byte.
assert.sameValue(typeof harden, 'function');
const o = {};
assert.sameValue(harden(o), o);
assert(Object.isFrozen(o));
