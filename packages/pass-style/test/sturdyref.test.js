import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';

import { passStyleOf, isPassable } from '../src/passStyleOf.js';
import { makeTagged } from '../src/makeTagged.js';
import { PASS_STYLE } from '../src/passStyle-helpers.js';

const { create, prototype: objectPrototype, isFrozen } = Object;

/**
 * A minimal stand-in for what the CapTP session manager (`@endo/ocapn`)
 * constructs. `@endo/pass-style` deliberately exports **no** maker — it only
 * defines and validates the `'sturdyref'` shape — so these tests build the
 * shape directly to exercise the recogniser. The shape is: an instance with
 * no own properties whose tag-record prototype carries `[PASS_STYLE]`,
 * `[Symbol.toStringTag]`, a get-only `location` accessor, and an optional
 * get-only `type` accessor. The secret is never a property.
 *
 * @param {object} location
 * @param {string} [type]
 */
const makeShapedSturdyRef = (location, type = undefined) => {
  const frozenLocation = harden(location);
  const descriptors = {
    [PASS_STYLE]: { value: 'sturdyref', enumerable: false },
    [Symbol.toStringTag]: { value: 'SturdyRef', enumerable: false },
    location: { get: () => frozenLocation, enumerable: false },
  };
  if (type !== undefined) {
    descriptors.type = { get: () => type, enumerable: false };
  }
  const proto = harden(create(objectPrototype, descriptors));
  return harden(create(proto));
};

const someLocation = harden({
  type: 'ocapn-peer',
  designator: 'peerB',
  transport: 'tcp-testing-only',
  network: 'tcp-testing-only',
  hints: false,
});

test('passStyleOf returns sturdyref for a shaped SturdyRef', t => {
  const sturdyRef = makeShapedSturdyRef(someLocation);
  t.is(passStyleOf(sturdyRef), 'sturdyref');
  t.true(isPassable(sturdyRef));
});

test('a SturdyRef is hardened and stringifies via its tag', t => {
  const sturdyRef = makeShapedSturdyRef(someLocation);
  t.true(isFrozen(sturdyRef), 'a SturdyRef is hardened');
  t.is(sturdyRef[Symbol.toStringTag], 'SturdyRef', 'tag is SturdyRef');
  t.is(String(sturdyRef), '[object SturdyRef]', 'stringifies via its tag');
});

test('location is a readable, deep-frozen locator; the secret is never a property', t => {
  const sturdyRef = makeShapedSturdyRef(someLocation);
  // The raw SturdyRef is the trusted/wire tier: its location is readable
  // by design.
  t.deepEqual(sturdyRef.location, someLocation, 'location is readable');
  t.true(isFrozen(sturdyRef.location), 'the returned location is deep-frozen');
  // The secret (swiss number) is never reachable — assert over own
  // properties and the whole prototype chain.
  for (const key of ['secret', 'swissNum', 'swissnum', 'payload']) {
    t.false(key in sturdyRef, `no ${key} anywhere on the SturdyRef`);
  }
  t.deepEqual(
    Reflect.ownKeys(sturdyRef),
    [],
    'a SturdyRef has no own properties',
  );
});

test('the optional type hint is a string when present, absent otherwise', t => {
  const withType = makeShapedSturdyRef(someLocation, 'some-type');
  t.is(withType.type, 'some-type', 'type hint is readable');
  t.is(passStyleOf(withType), 'sturdyref');

  const withoutType = makeShapedSturdyRef(someLocation);
  t.is(withoutType.type, undefined, 'no type hint by default');
  t.false('type' in withoutType, 'no type accessor when no hint given');
});

test('assertValid rejects a non-string type hint', t => {
  const badType = makeShapedSturdyRef(someLocation, /** @type {any} */ (42));
  t.throws(() => passStyleOf(badType), {
    message: /type hint must be a string/,
  });
  t.false(isPassable(badType));
});

test('assertValid rejects a location that is not a valid OcapnLocation', t => {
  const noDesignator = makeShapedSturdyRef(
    /** @type {any} */ ({ hints: false }),
  );
  t.throws(() => passStyleOf(noDesignator), {
    message: /designator/,
  });

  const notARecord = makeShapedSturdyRef(/** @type {any} */ ([]));
  t.throws(() => passStyleOf(notARecord), {
    message: /location must be a copyRecord/,
  });
});

test('a SturdyRef embeds in copyRecords and copyArrays', t => {
  const sturdyRef = makeShapedSturdyRef(someLocation);
  const record = harden({ ref: sturdyRef, note: 'hi' });
  t.is(passStyleOf(record), 'copyRecord');
  const array = harden([sturdyRef, sturdyRef]);
  t.is(passStyleOf(array), 'copyArray');
});

test('an instance carrying an own location data property is rejected', t => {
  // A forger cannot shadow the trusted prototype getter with an own data
  // property: the instance must carry no own properties.
  const sturdyRef = makeShapedSturdyRef(someLocation);
  const forged = harden(
    create(Object.getPrototypeOf(sturdyRef), {
      location: { value: harden({ evil: true }), enumerable: false },
    }),
  );
  t.throws(() => passStyleOf(forged), {
    message: /no own properties/,
  });
});

test('a makeTagged value with the sturdyref tag is not a SturdyRef', t => {
  // makeTagged produces a 'tagged' pass-style record; even when its tag
  // string is 'sturdyref' it is not a first-class SturdyRef.
  const decoy = makeTagged('sturdyref', undefined);
  t.is(passStyleOf(decoy), 'tagged');
});

test('a bare sturdyref-tagged record with no location accessor is rejected', t => {
  // Carrying [PASS_STYLE] = 'sturdyref' on the instance (rather than a
  // proper tag-record prototype with a location accessor) is not enough.
  const forged = harden(
    create(objectPrototype, {
      [PASS_STYLE]: { value: 'sturdyref', enumerable: false },
      [Symbol.toStringTag]: { value: 'SturdyRef', enumerable: false },
    }),
  );
  t.throws(() => passStyleOf(forged));
  t.false(isPassable(forged));
});

test('distinct SturdyRefs are distinct even with equal locations', t => {
  const a = makeShapedSturdyRef(someLocation);
  const b = makeShapedSturdyRef(someLocation);
  t.not(a, b);
  t.deepEqual(a.location, b.location);
});
