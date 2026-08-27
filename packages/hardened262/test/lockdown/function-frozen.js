/*---
flags: []
---*/
// `Object.isFrozen(Function)` is a hardening postcondition, not an ambient truth:
// `Function` is frozen only after `harden` reaches it (native XS freezes
// primordials lazily on first `harden`; both shims freeze `Function` at
// `lockdown()`). `harden` is ambient on native XS and the SES-on-XS shim but
// installed only at `lockdown()` on the pure-JS Node shim, so guard on its
// availability, then exercise it, so the case runs in every scenario (module +
// lockdownModule) and asserts the postcondition wherever `harden` can establish
// it rather than only in the lockdown column.
if (typeof harden === 'function') {
  harden(Function);
  assert(Object.isFrozen(Function));
}
