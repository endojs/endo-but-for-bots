import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';

import { passStyleOf, isPassable } from '../src/passStyleOf.js';
import { makeTagged } from '../src/makeTagged.js';
import { PASS_STYLE } from '../src/passStyle-helpers.js';
import { makeSturdyRef } from '../src/sturdyref.js';
import { isSturdyRef } from '../src/sturdy-ref.js';

const { create, prototype: objectPrototype, isFrozen, getPrototypeOf } = Object;

test('passStyleOf returns sturdyRef for a made SturdyRef', t => {
  const sturdyRef = makeSturdyRef();
  t.is(passStyleOf(sturdyRef), 'sturdyRef');
  t.true(isPassable(sturdyRef));
  t.true(isSturdyRef(sturdyRef));
});

test('a SturdyRef is opaque, hardened, and stringifies via its tag', t => {
  const sturdyRef = makeSturdyRef();
  t.true(isFrozen(sturdyRef), 'a SturdyRef is hardened');
  t.is(sturdyRef[Symbol.toStringTag], 'SturdyRef', 'tag is SturdyRef');
  t.is(String(sturdyRef), '[object SturdyRef]', 'stringifies via its tag');
  t.deepEqual(
    Reflect.ownKeys(sturdyRef),
    [],
    'a SturdyRef has no own properties',
  );
  // A SturdyRef reveals nothing about where it points: no location, no
  // secret, no type — anywhere on the instance or its prototype chain.
  for (const key of [
    'location',
    'secret',
    'swissNum',
    'swissnum',
    'type',
    'payload',
  ]) {
    t.false(key in sturdyRef, `no ${key} anywhere on the SturdyRef`);
  }
});

test('distinct SturdyRefs have distinct identities', t => {
  const a = makeSturdyRef();
  const b = makeSturdyRef();
  t.not(a, b);
  t.is(passStyleOf(a), 'sturdyRef');
  t.is(passStyleOf(b), 'sturdyRef');
});

test('a SturdyRef embeds in copyRecords and copyArrays', t => {
  const sturdyRef = makeSturdyRef();
  const record = harden({ ref: sturdyRef, note: 'hi' });
  t.is(passStyleOf(record), 'copyRecord');
  const array = harden([sturdyRef, sturdyRef]);
  t.is(passStyleOf(array), 'copyArray');
});

test('isSturdyRef rejects non-SturdyRefs', t => {
  t.false(isSturdyRef({}), 'plain object');
  t.false(isSturdyRef(null), 'null');
  t.false(isSturdyRef(undefined), 'undefined');
  t.false(isSturdyRef('string'), 'string');
  t.false(isSturdyRef(makeTagged('sturdyRef', undefined)), 'tagged decoy');
});

// A forged candidate whose prototype is a proper sturdyRef tag record but which
// carries an extra own data property is rejected: a SturdyRef is opaque, so a
// forger cannot smuggle attacker-chosen data onto it.
test('passStyleOf throws for a forged candidate with extra own properties', t => {
  const genuine = makeSturdyRef();
  const proto = getPrototypeOf(genuine);
  const forged = harden(
    create(proto, {
      location: { value: harden({ evil: true }), enumerable: false },
    }),
  );
  t.throws(() => passStyleOf(forged), {
    message: /no own properties/,
  });
  t.false(isPassable(forged));
  t.false(isSturdyRef(forged));
});

// A candidate whose prototype is not a proper sturdyRef tag record (here the
// PASS_STYLE marker sits on the instance rather than a tag-record prototype
// inheriting from Object.prototype) is rejected.
test('passStyleOf throws for a candidate with an invalid prototype', t => {
  const forged = harden(
    create(objectPrototype, {
      [PASS_STYLE]: { value: 'sturdyRef', enumerable: false },
      [Symbol.toStringTag]: { value: 'SturdyRef', enumerable: false },
    }),
  );
  // The marker is an own property of the instance, not carried by a
  // tag-record prototype, so the instance has an own property and is rejected.
  t.throws(() => passStyleOf(forged));
  t.false(isPassable(forged));
  t.false(isSturdyRef(forged));
});

test('passStyleOf throws for extra properties on the sturdyRef prototype', t => {
  // A tag record carrying more than the pass-style metadata (an opaque
  // SturdyRef must expose nothing) is rejected.
  const proto = harden(
    create(objectPrototype, {
      [PASS_STYLE]: { value: 'sturdyRef', enumerable: false },
      [Symbol.toStringTag]: { value: 'SturdyRef', enumerable: false },
      location: { get: () => harden({ leaked: true }), enumerable: false },
    }),
  );
  const forged = harden(create(proto));
  t.throws(() => passStyleOf(forged), {
    message: /Unexpected properties on sturdyref prototype/,
  });
  t.false(isSturdyRef(forged));
});

test('passStyleOf throws for a wrong tag on the sturdyRef prototype', t => {
  const proto = harden(
    create(objectPrototype, {
      [PASS_STYLE]: { value: 'sturdyRef', enumerable: false },
      [Symbol.toStringTag]: { value: 'NotSturdyRef', enumerable: false },
    }),
  );
  const forged = harden(create(proto));
  t.throws(() => passStyleOf(forged), {
    message: /sturdyref tag must be/,
  });
});

test('a makeTagged value with the sturdyRef tag is not a SturdyRef', t => {
  // makeTagged produces a 'tagged' pass-style record; even when its tag
  // string is 'sturdyRef' it is not a first-class SturdyRef.
  const decoy = makeTagged('sturdyRef', undefined);
  t.is(passStyleOf(decoy), 'tagged');
});
