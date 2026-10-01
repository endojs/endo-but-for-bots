import '@endo/sturdyref/shim.js';
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { isDeepStrictEqual } from 'node:util';
import fc from 'fast-check';
import { Far, Remotable } from '@endo/marshal';
import { isPromise } from '@endo/promise-kit';
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

test('enlivening an unknown CapTP SturdyRef export is a protocol failure', t => {
  /** @type {any[]} */
  const observed = [];
  const connection = makeCapTP('alice', () => {}, undefined, {
    onReject: (error, context) => observed.push({ error, context }),
  });

  t.false(
    connection.dispatch({
      type: 'CTP_CALL',
      epoch: 0,
      questionID: 'q-1',
      target: 's-1',
      method: connection.serialize(harden(['enliven', []])),
    }),
  );
  t.is(observed.length, 1);
  t.regex(observed[0].error.message, /Unknown export "s\+1"/);
  t.deepEqual(observed[0].context, { kind: 'protocol' });
});

test('a SturdyRef crosses CapTP with custom import/export tables', async t => {
  // Tables that know only the 'o' and 'p' slot kinds, as a custom table
  // written before SturdyRefs existed would.
  const makeCapTPImportExportTables = ({ makeRemoteKit }) => {
    const slotToExported = new Map();
    const slotToImported = new Map();
    let lastID = 0;
    return {
      makeSlotForValue: val => {
        lastID += 1;
        return `${isPromise(val) ? 'p' : 'o'}+${lastID}`;
      },
      makeValueForSlot: (slot, iface) => {
        slot[0] === 'o' || slot[0] === 'p' || assert.fail(`kind ${slot}`);
        const { promise, settler } = makeRemoteKit(slot);
        const val =
          slot[0] === 'p'
            ? promise
            : Remotable(iface, undefined, settler.resolveWithPresence());
        return { val, settler };
      },
      hasImport: slot => slotToImported.has(slot),
      getImport: slot => slotToImported.get(slot),
      markAsImported: (slot, val) => slotToImported.set(slot, val),
      hasExport: slot => slotToExported.has(slot),
      getExport: slot => slotToExported.get(slot),
      markAsExported: (slot, val) => slotToExported.set(slot, val),
      deleteExport: slot => slotToExported.delete(slot),
      didDisconnect: () => slotToImported.clear(),
    };
  };
  const target = Far('target', { hello: () => 'hi' });
  const origin = new SturdyRef({ enliven: () => target });
  const opts = { makeCapTPImportExportTables };
  /** @type {any} */
  let right;
  const left = makeCapTP('left', obj => right.dispatch(obj), undefined, opts);
  right = makeCapTP(
    'right',
    obj => left.dispatch(obj),
    Far('bootstrap', { getRef: () => origin }),
    opts,
  );

  const imported = await E(left.getBootstrap()).getRef();
  t.is(passStyleOf(imported), 'sturdyRef', 'not imported as a remotable');
  const live = /** @type {any} */ (await SturdyRef.enliven(imported));
  t.is(await E(live).hello(), 'hi');
});

test('a CapTP SturdyRef enliven facet refuses other methods and arguments', async t => {
  /** @type {any[]} */
  const sent = [];
  const connection = makeCapTP('alice', obj => sent.push(obj), undefined);
  const origin = new SturdyRef({ enliven: () => 'live' });
  const { slots } = connection.serialize(harden(origin));
  t.deepEqual(slots, ['s+1']);

  /**
   * @param {string} questionID
   * @param {any[]} method
   */
  const call = async (questionID, method) => {
    connection.dispatch({
      type: 'CTP_CALL',
      epoch: 0,
      questionID,
      target: 's-1',
      method: connection.serialize(harden(method)),
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    const reply = sent.find(m => m.answerID === questionID);
    if (!reply) throw Error(`no reply to ${questionID}`);
    return reply;
  };

  const ok = await call('q-1', ['enliven', []]);
  t.is(ok.exception, undefined);
  t.is(connection.unserialize(ok.result), 'live');

  for (const [questionID, method] of /** @type {const} */ ([
    ['q-2', ['enliven', ['extra']]],
    ['q-3', ['toString', []]],
    ['q-4', ['hasOwnProperty', ['enliven']]],
    ['q-5', ['enliven']],
  ])) {
    // eslint-disable-next-line no-await-in-loop
    const reply = await call(questionID, [...method]);
    t.not(reply.exception, undefined, `${method[0]} is refused`);
  }
});

/**
 * Connect two CapTP instances directly, with options for each side.
 *
 * @param {object} leftOptions
 * @param {object} rightOptions
 */
const makeOptionsPair = (leftOptions, rightOptions) => {
  /** @type {any} */
  let right;
  const left = makeCapTP(
    'left',
    obj => right.dispatch(obj),
    undefined,
    leftOptions,
  );
  right = makeCapTP(
    'right',
    obj => left.dispatch(obj),
    undefined,
    rightOptions,
  );
  return { left, right };
};

test('a SturdyRef constructed from data enlivens through the peer locator', async t => {
  const target = Far('target', { hello: () => 'hi' });
  const located = [];
  const { left } = makeOptionsPair(
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
    network: 'tcp-testing-only',
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
  const { left } = makeOptionsPair({ peerId: 'right' }, {});
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
  t.throws(
    () =>
      left.makeSturdyRefFromData(
        /** @type {any} */ ({
          peerId: 'right',
          objectId: 'x',
          hints: { host: 'h', [Symbol('smuggled')]: {} },
        }),
      ),
    { message: /hints must be a record of strings/ },
  );
  let reads = 0;
  const fickle = {
    get port() {
      reads += 1;
      return reads === 1 ? '1234' : {};
    },
  };
  const ref = left.makeSturdyRefFromData({
    peerId: 'right',
    objectId: 'x',
    hints: /** @type {any} */ (fickle),
  });
  t.is(reads, 1);
  t.deepEqual(left.getSturdyRefData(ref)?.hints, { port: '1234' });
});

test('constructing a SturdyRef from data rejects non-objects and symbol keys', t => {
  const { left } = makeOptionsPair({}, {});
  t.throws(() => left.makeSturdyRefFromData(/** @type {any} */ (null)), {
    message: /data must be an object/,
  });
  t.throws(
    () =>
      left.makeSturdyRefFromData(
        /** @type {any} */ ({
          peerId: 'right',
          objectId: 'x',
          [Symbol('smuggled')]: true,
        }),
      ),
    { message: /Unexpected SturdyRef data properties/ },
  );
});

test('no SturdyRef data validation error reveals the objectId', t => {
  const { left } = makeOptionsPair({ peerId: 'right' }, {});
  // The prefix keeps a short generated id from matching ordinary message text.
  const objectIds = fc.string({ minLength: 1 }).map(id => `swiss:${id}`);
  /** @type {Record<string, unknown>[]} */
  const invalid = [
    { peerId: 'other' },
    { peerId: 1 },
    { peerId: 'right', extra: true },
    { peerId: 'right', network: 1 },
    { peerId: 'right', hints: null },
    { peerId: 'right', hints: { port: 1 } },
  ];
  fc.assert(
    fc.property(objectIds, fc.constantFrom(...invalid), (objectId, base) => {
      let message = '';
      try {
        left.makeSturdyRefFromData(/** @type {any} */ ({ ...base, objectId }));
      } catch (error) {
        message = /** @type {Error} */ (error).message;
      }
      return message !== '' && !message.includes(objectId);
    }),
  );
  t.pass();
});

test('a SturdyRef from data rejects when the peer locates nothing', async t => {
  const { left } = makeOptionsPair({}, { locateSturdyRef: () => undefined });
  const ref = left.makeSturdyRefFromData({
    peerId: 'right',
    objectId: 'secret-swiss',
  });
  const error = await t.throwsAsync(() => SturdyRef.enliven(ref), {
    message: /has no SturdyRef for the requested object id/,
  });
  t.notRegex(error?.message ?? '', /secret-swiss/);
});

test('a peer-chosen question id cannot shadow the SturdyRef locator', async t => {
  const target = Far('target', { hello: () => 'hi' });
  const decoy = Far('decoy', { hello: () => 'decoy' });
  /** @type {any} */
  let right;
  const left = makeCapTP('left', obj => right.dispatch(obj), undefined, {});
  right = makeCapTP('right', obj => left.dispatch(obj), decoy, {
    locateSturdyRef: objectId => (objectId === 'x' ? target : undefined),
  });
  // Ask a question whose id is the reserved locator slot, so its answer
  // would shadow the locator if `answers` were consulted first.
  right.dispatch({
    type: 'CTP_CALL',
    epoch: 0,
    questionID: 'l-0',
    target: 'o+0',
    method: right.serialize(harden(['hello', []])),
  });
  const ref = left.makeSturdyRefFromData({ peerId: 'right', objectId: 'x' });
  const live = await SturdyRef.enliven(ref);
  t.is(await E(live).hello(), 'hi');
});

test('a SturdyRef from data rejects without a peer locator or connection', async t => {
  const { left } = makeOptionsPair({}, {});
  const ref = left.makeSturdyRefFromData({ peerId: 'right', objectId: 'x' });
  await t.throwsAsync(() => SturdyRef.enliven(ref), {
    message: /does not locate SturdyRefs from data/,
  });

  const { left: left2 } = makeOptionsPair(
    {},
    { locateSturdyRef: () => Far('t', {}) },
  );
  const ref2 = left2.makeSturdyRefFromData({ peerId: 'right', objectId: 'x' });
  left2.abort(Error('gone'));
  await t.throwsAsync(() => SturdyRef.enliven(ref2), { message: /gone/ });
});

test('constructing a SturdyRef from data checks each coordinate type', t => {
  const { left } = makeOptionsPair({}, {});
  t.throws(
    () =>
      left.makeSturdyRefFromData(
        /** @type {any} */ ({ peerId: 1, objectId: 'x' }),
      ),
    { message: /peerId must be a string/ },
  );
  t.throws(
    () =>
      left.makeSturdyRefFromData(
        /** @type {any} */ ({ peerId: 'right', objectId: 'x', network: 1 }),
      ),
    { message: /network must be a string/ },
  );
  t.throws(
    () =>
      left.makeSturdyRefFromData(
        /** @type {any} */ ({ peerId: 'right', objectId: 'x', hints: null }),
      ),
    { message: /hints must be a record of strings/ },
  );
  // Without our own `peerId`, any peer name is accepted, and omitted
  // coordinates are recorded as their defaults.
  const ref = left.makeSturdyRefFromData({ peerId: 'anyone', objectId: 'x' });
  t.deepEqual(left.getSturdyRefData(ref), {
    peerId: 'anyone',
    objectId: 'x',
    hints: {},
  });
});

test('the SturdyRef locator refuses a non-string object id', async t => {
  const { left } = makeOptionsPair({}, { locateSturdyRef: () => Far('t', {}) });
  const { promise } = left.makeRemoteKit('l-0');
  const locator = /** @type {any} */ (promise);
  await t.throwsAsync(() => E(locator).locate(1), {
    message: /object id must be a string/,
  });
});

test('constructing a SturdyRef from data refuses non-enumerable properties', t => {
  const { left } = makeOptionsPair({}, {});
  const data = { peerId: 'right', objectId: 'x' };
  Object.defineProperty(data, 'smuggled', { value: true, enumerable: false });
  t.throws(() => left.makeSturdyRefFromData(data), {
    message: /Unexpected SturdyRef data properties/,
  });
  /** @type {Record<string, string>} */
  const hints = {};
  Object.defineProperty(hints, 'port', { value: '1', enumerable: false });
  t.throws(
    () => left.makeSturdyRefFromData({ peerId: 'right', objectId: 'x', hints }),
    { message: /hints must be a record of strings/ },
  );
});

test('a CapTP returns the data it constructed a SturdyRef from', t => {
  const { left } = makeOptionsPair({}, {});
  const sturdyRefDataArbitrary = fc
    .tuple(
      fc.string(),
      fc.string(),
      fc.option(fc.string(), { nil: undefined }),
      fc.option(fc.array(fc.tuple(fc.string(), fc.string())), {
        nil: undefined,
      }),
    )
    .map(([peerId, objectId, network, hintEntries]) => ({
      peerId,
      objectId,
      ...(network === undefined ? {} : { network }),
      ...(hintEntries === undefined
        ? {}
        : { hints: Object.fromEntries(hintEntries) }),
    }));
  fc.assert(
    fc.property(sturdyRefDataArbitrary, data =>
      isDeepStrictEqual(
        left.getSturdyRefData(left.makeSturdyRefFromData(data)),
        // The recorded data always has hints.
        { hints: {}, ...data },
      ),
    ),
  );
  t.pass();
});
