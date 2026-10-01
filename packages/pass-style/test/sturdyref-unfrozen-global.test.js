import test from '@endo/ses-ava/test.js';

import { passStyleOf } from '../src/passStyleOf.js';

const { create, defineProperty, freeze } = Object;

test('an unfrozen SturdyRef global is not trusted', t => {
  // The shim always freezes its constructor, its statics, and its prototype.
  // A global that could still be changed vouches for nothing.
  // `Object.isFrozen({}) === true` detects unsafe harden taming, under which
  // `isFrozen` answers true for everything and cannot tell the two apart.
  if (Object.isFrozen({})) {
    t.pass('unsafe taming: isFrozen cannot detect an unfrozen global');
    return;
  }
  const impostor = function SturdyRef() {};
  // Shaped like the shim's prototype, so that only the condition under test
  // can reject the impostor.
  defineProperty(impostor.prototype, Symbol.toStringTag, {
    value: 'SturdyRef',
  });
  impostor.isSturdyRef = () => true;
  freeze(impostor.isSturdyRef);
  freeze(impostor.prototype);
  /** @type {any} */ (globalThis).SturdyRef = impostor;
  try {
    const candidate = freeze(create(impostor.prototype));
    t.throws(() => passStyleOf(candidate));
  } finally {
    delete (/** @type {any} */ (globalThis).SturdyRef);
  }
});
