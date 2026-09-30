import '@endo/sturdyref/shim.js';
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
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
