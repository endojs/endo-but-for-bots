/*---
flags: []
---*/
// The `harden` global exists, is callable, returns the object it is given, and
// leaves that object frozen. The smoke test the rest of the suite presumes;
// distinct from property.js (which pins transitive freezing across a property
// edge), which this file previously duplicated byte-for-byte.
//
// `harden` is ambient on native XS and the SES-on-XS shim but installed only at
// `lockdown()` on the pure-JS Node shim, so guard on its availability to run in
// every scenario (module + lockdownModule) rather than only the lockdown column.
if (typeof harden === 'function') {
  assert.sameValue(typeof harden, 'function');
  const o = {};
  assert.sameValue(harden(o), o);
  assert(Object.isFrozen(o));
}
