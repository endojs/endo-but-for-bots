import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';

import { passStyleOf, isPassable } from '../src/passStyleOf.js';
import { makeSturdyRef, getStudyRefLocator } from '../src/sturdyref.js';
import { makeTagged } from '../src/makeTagged.js';
import { PASS_STYLE } from '../src/passStyle-helpers.js';

const { create, prototype: objectPrototype, isFrozen } = Object;

test('passStyleOf returns sturdyref for a minted SturdyRef', t => {
  const locator = harden({ transport: 'ocapn-tcp', secret: 'swiss-num' });
  const sturdyRef = makeSturdyRef(locator);
  t.is(passStyleOf(sturdyRef), 'sturdyref');
  t.true(isPassable(sturdyRef));
});

test('a minted SturdyRef is opaque and hardened', t => {
  const locator = harden({ location: { peer: 'B' }, secret: 'shh' });
  const sturdyRef = makeSturdyRef(locator);
  t.true(isFrozen(sturdyRef), 'a SturdyRef is hardened');
  t.is(sturdyRef[Symbol.toStringTag], 'SturdyRef', 'tag is SturdyRef');
  t.is(String(sturdyRef), '[object SturdyRef]', 'stringifies via its tag');
  // The locator and its secret never appear as own properties: the only
  // way to recover them is the off-band getStudyRefLocator.
  t.false('payload' in sturdyRef, 'no payload property');
  t.is(/** @type {any} */ (sturdyRef).payload, undefined, 'no payload value');
  t.false('location' in sturdyRef, 'no location property');
  t.false('secret' in sturdyRef, 'no secret property');
});

test('getStudyRefLocator round-trips the off-band locator', t => {
  const locator = harden({ location: { peer: 'B' }, secret: 'swiss-num' });
  const sturdyRef = makeSturdyRef(locator);
  t.is(getStudyRefLocator(sturdyRef), locator, 'returns the same locator');
  t.deepEqual(getStudyRefLocator(sturdyRef), {
    location: { peer: 'B' },
    secret: 'swiss-num',
  });
});

test('makeSturdyRef hardens an unhardened locator', t => {
  const sturdyRef = makeSturdyRef({ secret: 'late-harden' });
  t.true(isFrozen(getStudyRefLocator(sturdyRef)), 'locator is hardened');
});

test('passStyleOf rejects a sturdyref-tagged record not minted by makeSturdyRef', t => {
  // A forged record carrying [PASS_STYLE] = 'sturdyref' but never minted
  // (so absent from the off-band WeakMap) must be rejected.
  const forged = harden(
    create(objectPrototype, {
      [PASS_STYLE]: { value: 'sturdyref' },
      [Symbol.toStringTag]: { value: 'SturdyRef' },
    }),
  );
  t.throws(() => passStyleOf(forged), {
    message: /minted by makeSturdyRef/,
  });
  t.false(isPassable(forged), 'a forged SturdyRef is not passable');
});

test('a makeTagged value with the sturdyref tag is not a SturdyRef', t => {
  // makeTagged produces a 'tagged' pass-style record; even when its tag
  // string is 'sturdyref' it is not a first-class SturdyRef.
  const decoy = makeTagged('sturdyref', undefined);
  t.is(passStyleOf(decoy), 'tagged');
  t.throws(() => getStudyRefLocator(/** @type {any} */ (decoy)), {
    message: /Not a SturdyRef minted by makeSturdyRef/,
  });
});

test('getStudyRefLocator throws for non-SturdyRef inputs', t => {
  t.throws(() => getStudyRefLocator(/** @type {any} */ (harden({}))), {
    message: /Not a SturdyRef minted by makeSturdyRef/,
  });
  t.throws(() => getStudyRefLocator(/** @type {any} */ ('string')), {
    message: /Not a SturdyRef minted by makeSturdyRef/,
  });
});

test('distinct SturdyRefs keep distinct locators', t => {
  const a = makeSturdyRef(harden({ secret: 'a' }));
  const b = makeSturdyRef(harden({ secret: 'b' }));
  t.not(a, b);
  t.is(getStudyRefLocator(a).secret, 'a');
  t.is(getStudyRefLocator(b).secret, 'b');
});
