import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';

import { passStyleOf } from '../src/passStyleOf.js';
import { Far } from '../src/make-far.js';
import { makeTagged } from '../src/makeTagged.js';

const { create, defineProperty, freeze } = Object;

test('a lying SturdyRef global cannot reclassify or observe other values', t => {
  // Something other than the shim claimed the global with a brand check that
  // vouches for everything. Pass-style trusts a frozen constructor, but asks
  // it only about empty objects that inherit from its own prototype, and only
  // after every other pass style has declined.
  /** @type {unknown[]} */
  const seen = [];
  const impostor = function SturdyRef() {};
  impostor.isSturdyRef = value => {
    seen.push(value);
    return true;
  };
  defineProperty(impostor.prototype, Symbol.toStringTag, {
    value: 'SturdyRef',
  });
  freeze(impostor.prototype);
  freeze(impostor.isSturdyRef);
  freeze(impostor);
  /** @type {any} */ (globalThis).SturdyRef = impostor;
  try {
    const far = Far('Thing', { foo: () => 'foo' });
    const record = harden({ a: 1 });
    const empty = harden({});
    const array = harden([far]);
    const tagged = makeTagged('box', record);
    const withMethods = harden({ transfer() {} });
    t.is(passStyleOf(far), 'remotable');
    t.is(passStyleOf(record), 'copyRecord');
    t.is(passStyleOf(empty), 'copyRecord');
    t.is(passStyleOf(array), 'copyArray');
    t.is(passStyleOf(tagged), 'tagged');
    t.throws(() => passStyleOf(withMethods));
    t.deepEqual(seen, []);

    // All it can do is make its own empty objects passable, which would
    // otherwise have been rejected.
    const own = freeze(create(impostor.prototype));
    t.is(passStyleOf(own), 'sturdyRef');
    t.deepEqual(seen, [own]);

    // Even its own prototype does not help a candidate that carries data.
    const withData = freeze(
      Object.assign(create(impostor.prototype), { a: 1 }),
    );
    t.throws(() => passStyleOf(withData));
    t.deepEqual(seen, [own]);
  } finally {
    delete (/** @type {any} */ (globalThis).SturdyRef);
  }
});
