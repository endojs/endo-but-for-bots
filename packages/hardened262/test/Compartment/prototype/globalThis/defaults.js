/*---
description: |
  Currently failing in SES.
  Passes with XS, but not with XS under Lockdown.
flags: [onlyStrict,noLockdown,noSesXs,noSesNode]
---*/

const c = new Compartment();
const globals = c.globalThis;
const names = Object.getOwnPropertyNames(globals);
const exceptions = [
  'Compartment',
  'Function',
  'NaN',
  'eval',
  'global',
  'globalThis',
];
// XS 9 exposes ModuleStuff as a distinct per-compartment host object.
// It is intentionally not shared by identity with the outer realm.
if (typeof ModuleStuff !== 'undefined') {
  exceptions.push('ModuleStuff');
}
for (let name of names) {
  const actual = globalThis[name] === globals[name];
  const expected = exceptions.indexOf(name) >= 0 ? false : true;
  assert.sameValue(actual, expected, name);
}
