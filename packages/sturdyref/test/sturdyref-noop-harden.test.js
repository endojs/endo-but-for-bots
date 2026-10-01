// @ts-nocheck
// An installed harden may be a no-op (`@endo/harden/noop.js`,
// `hardenTaming: 'unsafe'`, or a plain `globalThis.harden = o => o`). The shim
// must still freeze its constructor, prototype, and statics, or later code
// could forge the brand for every eval twin. Isolated in its own file (its own
// process) because it plants a global harden.

import test from 'ava';

globalThis.harden = o => o;

const { provideSturdyRef } = await import('../src/sturdyref-shim.js');
const { isSturdyRef } = await import('../src/sturdyref-pony.js');

const { isFrozen } = Object;

test('a no-op harden still leaves the constructor frozen', t => {
  const SturdyRef = provideSturdyRef();
  t.true(isFrozen(SturdyRef));
  t.true(isFrozen(SturdyRef.prototype));
  t.true(isFrozen(SturdyRef.enliven));
  t.true(isFrozen(SturdyRef.isSturdyRef));
  t.throws(() => {
    SturdyRef.isSturdyRef = () => true;
  });
  t.false(isSturdyRef({}));
});
