/*---
flags: [onlyLockdown]
---*/
// The proto OF a property: o is the prototype of p, and p is a property of q.
// Distinct from transitive-proto.js (two proto edges) and property-of-proto.js
// (proto then property): here the reach is a property edge (q->p) followed by a
// prototype edge (p->o), so harden must cross both to freeze o.
const o = {};
const p = Object.create(o);
const q = { p };
harden(q);
assert(Object.isFrozen(q));
assert(Object.isFrozen(p));
assert(Object.isFrozen(o));
