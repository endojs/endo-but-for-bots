// prefer-endo-primitives-exempt: this low-level pass-style test cannot depend on @endo/exo, which depends on pass-style.
import assert from 'node:assert/strict';

import 'ses';
import harden from '@endo/harden';

import { Far } from '../src/make-far.js';
import { makeTagged } from '../src/makeTagged.js';

const { create, defineProperty, freeze } = Object;
const scenario = process.argv[2];

assert.equal(Object.hasOwn(globalThis, 'Parcel'), false);

const install = value => {
  defineProperty(globalThis, 'Parcel', {
    configurable: true,
    writable: true,
    value,
  });
};

/**
 * @param {(impostor: any) => void} [breakIt]
 * @param {object} [options]
 * @param {boolean} [options.freezeCheck]
 * @param {boolean} [options.freezePrototype]
 */
const makeImpostor = (
  breakIt = () => {},
  { freezeCheck = true, freezePrototype = true } = {},
) => {
  const impostor = function Parcel() {};
  impostor.isParcel = () => true;
  defineProperty(impostor.prototype, Symbol.toStringTag, { value: 'Parcel' });
  breakIt(impostor);
  if (freezeCheck) freeze(impostor.isParcel);
  if (freezePrototype && impostor.prototype) freeze(impostor.prototype);
  return freeze(impostor);
};

const candidateFor = impostor =>
  freeze(
    create(
      typeof impostor.prototype === 'object' || impostor.prototype === null
        ? impostor.prototype
        : null,
    ),
  );

const importParcelCheck = async () => {
  const { isParcelObject } = await import('../src/parcel.js');
  return isParcelObject;
};

const expectTrust = async (impostor, expected) => {
  install(impostor);
  const isParcelObject = await importParcelCheck();
  assert.equal(isParcelObject(candidateFor(impostor)), expected);
};

const brokenImpostors = {
  'unfrozen-check': () => makeImpostor(undefined, { freezeCheck: false }),
  'unfrozen-prototype': () =>
    makeImpostor(undefined, { freezePrototype: false }),
  'null-prototype': () =>
    makeImpostor(impostor => {
      impostor.prototype = null;
    }),
  'prototype-method': () =>
    makeImpostor(impostor => {
      impostor.prototype.transfer = () => {};
    }),
  'accessor-tag': () =>
    makeImpostor(impostor => {
      impostor.prototype = {};
      defineProperty(impostor.prototype, 'constructor', { value: impostor });
      defineProperty(impostor.prototype, Symbol.toStringTag, {
        get: () => 'Parcel',
      });
    }),
  'wrong-tag': () =>
    makeImpostor(impostor => {
      impostor.prototype = {};
      defineProperty(impostor.prototype, 'constructor', { value: impostor });
      defineProperty(impostor.prototype, Symbol.toStringTag, {
        value: 'Remotable',
      });
    }),
  'foreign-parent': () =>
    makeImpostor(impostor => {
      impostor.prototype = create(null);
      defineProperty(impostor.prototype, 'constructor', { value: impostor });
      defineProperty(impostor.prototype, Symbol.toStringTag, {
        value: 'Parcel',
      });
    }),
  'foreign-constructor': () =>
    makeImpostor(impostor => {
      impostor.prototype = {};
      defineProperty(impostor.prototype, 'constructor', {
        value: function Other() {},
      });
      defineProperty(impostor.prototype, Symbol.toStringTag, {
        value: 'Parcel',
      });
    }),
  'enumerable-tag': () =>
    makeImpostor(impostor => {
      impostor.prototype = {};
      defineProperty(impostor.prototype, 'constructor', { value: impostor });
      defineProperty(impostor.prototype, Symbol.toStringTag, {
        enumerable: true,
        value: 'Parcel',
      });
    }),
  'enumerable-constructor': () =>
    makeImpostor(impostor => {
      impostor.prototype = {};
      defineProperty(impostor.prototype, 'constructor', {
        enumerable: true,
        value: impostor,
      });
      defineProperty(impostor.prototype, Symbol.toStringTag, {
        value: 'Parcel',
      });
    }),
  'accessor-check': () =>
    makeImpostor(
      impostor => {
        delete impostor.isParcel;
        defineProperty(impostor, 'isParcel', {
          get() {
            throw Error('boom');
          },
        });
      },
      { freezeCheck: false },
    ),
};

await null;

if (scenario === 'absent') {
  const isParcelObject = await importParcelCheck();
  assert.equal(isParcelObject(freeze({})), false);
} else if (scenario === 'well-shaped') {
  await expectTrust(makeImpostor(), true);
} else if (Object.hasOwn(brokenImpostors, scenario)) {
  await expectTrust(brokenImpostors[scenario](), false);
} else if (scenario === 'accessor-global') {
  let reads = 0;
  defineProperty(globalThis, 'Parcel', {
    configurable: true,
    get() {
      reads += 1;
      throw Error('boom');
    },
  });
  const isParcelObject = await importParcelCheck();
  assert.equal(isParcelObject(freeze({})), false);
  assert.equal(reads, 0);
} else if (scenario === 'replacement') {
  const malformed = makeImpostor(impostor => {
    impostor.prototype.transfer = () => {};
  });
  const wellShaped = makeImpostor();
  install(malformed);
  const isParcelObject = await importParcelCheck();
  assert.equal(isParcelObject(candidateFor(malformed)), false);
  install(wellShaped);
  assert.equal(isParcelObject(candidateFor(wellShaped)), true);
} else if (scenario === 'captured') {
  const first = makeImpostor();
  const second = makeImpostor();
  install(first);
  const isParcelObject = await importParcelCheck();
  assert.equal(isParcelObject(candidateFor(first)), true);
  install(second);
  assert.equal(isParcelObject(candidateFor(second)), false);
  assert.equal(isParcelObject(candidateFor(first)), true);
} else if (scenario === 'lying') {
  const seen = [];
  const impostor = makeImpostor(candidate => {
    candidate.isParcel = value => {
      seen.push(value);
      return true;
    };
  });
  install(impostor);
  const { passStyleOf } = await import('../src/passStyleOf.js');
  const far = Far('Thing', { foo: () => 'foo' });
  const record = harden({ a: 1 });
  const array = harden([far]);
  const tagged = makeTagged('box', record);
  assert.equal(passStyleOf(far), 'remotable');
  assert.equal(passStyleOf(record), 'copyRecord');
  assert.equal(passStyleOf(array), 'copyArray');
  assert.equal(passStyleOf(tagged), 'tagged');
  assert.deepEqual(seen, []);
  const own = candidateFor(impostor);
  assert.equal(passStyleOf(own), 'parcel');
  assert.deepEqual(seen, [own]);
} else if (scenario === 'malformed') {
  const impostor = function Parcel() {};
  defineProperty(impostor.prototype, Symbol.toStringTag, { value: 'Parcel' });
  freeze(impostor.prototype);
  install(freeze(impostor));
  const { passStyleOf } = await import('../src/passStyleOf.js');
  assert.throws(() => passStyleOf(candidateFor(impostor)));
} else if (scenario === 'reentrant') {
  const impostor = function Parcel() {};
  defineProperty(impostor.prototype, Symbol.toStringTag, { value: 'Parcel' });
  const reentrant = candidateFor(impostor);
  let calls = 0;
  const { passStyleOf } = await import('../src/passStyleOf.js');
  impostor.isParcel = value => {
    calls += 1;
    assert.throws(() => passStyleOf(value));
    return true;
  };
  freeze(impostor.prototype);
  freeze(impostor.isParcel);
  install(freeze(impostor));
  assert.equal(passStyleOf(reentrant), 'parcel');
  assert.equal(calls, 1);
} else if (scenario === 'throwing') {
  const impostor = function Parcel() {};
  defineProperty(impostor.prototype, Symbol.toStringTag, { value: 'Parcel' });
  const throwing = candidateFor(impostor);
  const truthy = candidateFor(impostor);
  impostor.isParcel = value => {
    if (value === throwing) throw Error('boom');
    return 1;
  };
  freeze(impostor.prototype);
  freeze(impostor.isParcel);
  install(freeze(impostor));
  const { passStyleOf } = await import('../src/passStyleOf.js');
  assert.throws(() => passStyleOf(throwing));
  assert.throws(() => passStyleOf(truthy));
} else if (scenario === 'throwing-then-true') {
  const impostor = function Parcel() {};
  defineProperty(impostor.prototype, Symbol.toStringTag, { value: 'Parcel' });
  const throwing = candidateFor(impostor);
  const genuine = candidateFor(impostor);
  impostor.isParcel = value => {
    if (value === throwing) throw Error('boom');
    return true;
  };
  freeze(impostor.prototype);
  freeze(impostor.isParcel);
  install(freeze(impostor));
  const { passStyleOf } = await import('../src/passStyleOf.js');
  assert.throws(() => passStyleOf(throwing));
  assert.equal(passStyleOf(genuine), 'parcel');
} else if (scenario === 'stateful') {
  let calls = 0;
  const impostor = makeImpostor(candidate => {
    candidate.isParcel = () => {
      calls += 1;
      return calls % 2 === 0;
    };
  });
  install(impostor);
  const { passStyleOf } = await import('../src/passStyleOf.js');
  // A decline is an error and is not memoized, so it may be asked again, but
  // once `passStyleOf` answers 'parcel' its memo keeps that answer.
  const candidate = candidateFor(impostor);
  assert.throws(() => passStyleOf(candidate));
  assert.equal(calls, 1);
  assert.equal(passStyleOf(candidate), 'parcel');
  assert.equal(passStyleOf(candidate), 'parcel');
  assert.equal(calls, 2);
} else if (scenario === 'proxy-global') {
  let traps = 0;
  install(
    new Proxy(
      freeze(function Parcel() {}),
      {
        isExtensible() {
          traps += 1;
          throw Error('proxy trap');
        },
      },
    ),
  );
  const isParcelObject = await importParcelCheck();
  assert.equal(isParcelObject(freeze({})), false);
  assert.equal(traps, 1);
} else if (scenario === 'unfrozen-global') {
  const impostor = function Parcel() {};
  defineProperty(impostor.prototype, Symbol.toStringTag, { value: 'Parcel' });
  impostor.isParcel = () => true;
  freeze(impostor.isParcel);
  freeze(impostor.prototype);
  install(impostor);
  const { passStyleOf } = await import('../src/passStyleOf.js');
  assert.throws(() => passStyleOf(candidateFor(impostor)));
} else {
  assert.fail(`unknown scenario ${scenario}`);
}
