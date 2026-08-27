/*---
flags: []
---*/
// `harden` is ambient on native XS and the SES-on-XS shim but installed only at
// `lockdown()` on the pure-JS Node shim, so guard on its availability to run in
// every scenario (module + lockdownModule) rather than only the lockdown column.
if (typeof harden === 'function') {
  assert.sameValue(typeof globalThis.harden, 'function');
}
