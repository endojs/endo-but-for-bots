/*---
flags: []
---*/
// `harden` is ambient on native XS and the SES-on-XS shim but installed only at
// `lockdown()` on the pure-JS Node shim, so guard on its availability to run in
// every scenario (module + lockdownModule) rather than only the lockdown column.
if (typeof harden === 'function') {
  let state = 0;
  const o = {
    __proto__: null,
    get state() {
      return state;
    },
    set state(value) {
      state = value * 2;
    },
  };
  harden(o);
  assert(Object.isFrozen(o));
  assert.sameValue(o.state, state);
  o.state = 2;
  assert.sameValue(o.state, 4);
}
