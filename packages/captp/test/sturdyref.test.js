import '@endo/sturdyref/shim.js';
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { Far } from '@endo/marshal';
import { passStyleOf } from '@endo/pass-style';
import { makeCapTP, E } from '../src/captp.js';

const { SturdyRef } = /** @type {any} */ (globalThis);

/**
 * Connect two CapTP instances directly, so the test can reach both sides.
 *
 * @param {any} leftBootstrap
 * @param {any} rightBootstrap
 */
const makePair = (leftBootstrap, rightBootstrap) => {
  /** @type {any} */
  let right;
  const left = makeCapTP('left', obj => right.dispatch(obj), leftBootstrap);
  right = makeCapTP('right', obj => left.dispatch(obj), rightBootstrap);
  return { left, right };
};

test('a SturdyRef crosses CapTP and enlivens at its origin', async t => {
  const target = Far('target', { hello: () => 'hi' });
  const enlivened = [];
  const origin = new SturdyRef({
    enliven(ref) {
      enlivened.push(ref);
      return target;
    },
  });
  const { left } = makePair(
    undefined,
    Far('bootstrap', {
      getRef: () => origin,
      isOrigin: ref => ref === origin,
      pair: () => harden([origin, origin]),
    }),
  );
  const bs = left.getBootstrap();

  const imported = await E(bs).getRef();
  t.true(SturdyRef.isSturdyRef(imported));
  t.is(passStyleOf(imported), 'sturdyRef');
  t.not(imported, origin, 'the far side mints its own ref');
  t.is(await E(bs).getRef(), imported, 'imports are deduplicated');

  const [a, b] = await E(bs).pair();
  t.is(a, b, 'one slot per ref within a message');
  t.is(a, imported);

  t.true(await E(bs).isOrigin(imported), 'passing it back yields the origin');

  const live = /** @type {any} */ (await SturdyRef.enliven(imported));
  t.is(await E(live).hello(), 'hi');
  t.deepEqual(enlivened, [origin], 'the origin handler enlivened');
});

test('enlivening a CapTP SturdyRef fails after abort', async t => {
  const origin = new SturdyRef({ enliven: () => 'never' });
  const { left } = makePair(
    undefined,
    Far('bootstrap', { getRef: () => origin }),
  );
  const imported = await E(left.getBootstrap()).getRef();
  left.abort(Error('gone'));
  await t.throwsAsync(() => SturdyRef.enliven(imported), {
    message: /gone/,
  });
});

test('a CapTP SturdyRef propagates origin enliven failure', async t => {
  const origin = new SturdyRef({
    enliven: () => {
      throw Error('expired');
    },
  });
  const { left } = makePair(
    undefined,
    Far('bootstrap', { getRef: () => origin }),
  );
  const imported = await E(left.getBootstrap()).getRef();
  await t.throwsAsync(() => SturdyRef.enliven(imported), {
    message: /expired/,
  });
});

test('a CapTP SturdyRef export answers only enliven', async t => {
  const origin = new SturdyRef({ enliven: () => 'live' });
  const { left } = makePair(
    undefined,
    Far('bootstrap', { getRef: () => origin }),
  );
  const imported = await E(left.getBootstrap()).getRef();
  t.is(await SturdyRef.enliven(imported), 'live');
  // Calling anything but `enliven` on a SturdyRef is a local error: the
  // ref has no methods, and the internal presence is unreachable.
  await t.throwsAsync(() => E(imported).enliven());
});

/**
 * Connect two CapTP instances directly, with options for each side.
 *
 * @param {object} leftOpts
 * @param {object} rightOpts
 */
const makeOptsPair = (leftOpts, rightOpts) => {
  /** @type {any} */
  let right;
  const left = makeCapTP(
    'left',
    obj => right.dispatch(obj),
    undefined,
    leftOpts,
  );
  right = makeCapTP('right', obj => left.dispatch(obj), undefined, rightOpts);
  return { left, right };
};

test('a SturdyRef constructed from data enlivens through the peer locator', async t => {
  const target = Far('target', { hello: () => 'hi' });
  const located = [];
  const { left } = makeOptsPair(
    { peerId: 'right' },
    {
      locateSturdyRef: objectId => {
        located.push(objectId);
        return objectId === 'swiss-1' ? target : undefined;
      },
    },
  );
  const data = {
    peerId: 'right',
    objectId: 'swiss-1',
    designator: 'tcp-testing-only',
    hints: { host: '127.0.0.1', port: '1234' },
  };
  const ref = left.makeSturdyRefFromData(data);
  t.is(passStyleOf(ref), 'sturdyRef');
  t.deepEqual(Reflect.ownKeys(ref), []);
  t.deepEqual(left.getSturdyRefData(ref), data);
  t.true(Object.isFrozen(left.getSturdyRefData(ref)));
  t.is(left.getSturdyRefData(harden({})), undefined);

  const live = await SturdyRef.enliven(ref);
  t.is(await E(live).hello(), 'hi');
  t.deepEqual(located, ['swiss-1']);

  // The recorded data reconstructs an equivalent, distinct ref.
  const again = left.makeSturdyRefFromData(data);
  t.not(again, ref);
  t.is(await E(await SturdyRef.enliven(again)).hello(), 'hi');
});

test('constructing a SturdyRef from data validates the data', t => {
  const { left } = makeOptsPair({ peerId: 'right' }, {});
  t.throws(
    () => left.makeSturdyRefFromData({ peerId: 'other', objectId: 'x' }),
    {
      message: /names peer "other"/,
    },
  );
  t.throws(
    () => left.makeSturdyRefFromData(/** @type {any} */ ({ peerId: 'right' })),
    {
      message: /objectId must be a string/,
    },
  );
  t.throws(
    () =>
      left.makeSturdyRefFromData(
        /** @type {any} */ ({ peerId: 'right', objectId: 'x', extra: 1 }),
      ),
    { message: /Unexpected SturdyRef data properties/ },
  );
  t.throws(
    () =>
      left.makeSturdyRefFromData(
        /** @type {any} */ ({
          peerId: 'right',
          objectId: 'x',
          hints: { port: 1 },
        }),
      ),
    { message: /hints must be a record of strings/ },
  );
});

test('a SturdyRef from data rejects without a peer locator or connection', async t => {
  const { left } = makeOptsPair({}, {});
  const ref = left.makeSturdyRefFromData({ peerId: 'right', objectId: 'x' });
  await t.throwsAsync(() => SturdyRef.enliven(ref), {
    message: /does not locate SturdyRefs from data/,
  });

  const { left: left2 } = makeOptsPair(
    {},
    { locateSturdyRef: () => Far('t', {}) },
  );
  const ref2 = left2.makeSturdyRefFromData({ peerId: 'right', objectId: 'x' });
  left2.abort(Error('gone'));
  await t.throwsAsync(() => SturdyRef.enliven(ref2), { message: /gone/ });
});
