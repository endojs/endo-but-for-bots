// Install the realm's SturdyRef before anything below can make one.
import '@endo/sturdyref/shim.js';
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { Far, passStyleOf } from '@endo/pass-style';

import { makeMarshal } from '../src/marshal.js';
import { decodeToJustin } from '../src/marshal-justin.js';
import { makeDotMembraneKit } from '../src/dot-membrane.js';
import { makePassableKit, passStylePrefixes } from '../src/encodePassable.js';
import { compareRank } from '../src/rankOrder.js';

/** @type {any} */
const { SturdyRef } = globalThis;

// A test handler stands in for the CapTP behaviors of a later layer: it
// enlivens a ref to a presence it closes over.
const makeRef = label => {
  const live = Far(label, { label: () => label });
  const ref = new SturdyRef(harden({ enliven: () => live }));
  return { ref, live };
};

// A slot table that keeps each SturdyRef in its own kind of slot and gives
// it back unchanged, the way a CapTP would keep an export table.
const makeSlotTable = () => {
  const slots = [];
  const convertValToSlot = val => {
    const kind = passStyleOf(val);
    slots.push(val);
    return `${kind}:${slots.length - 1}`;
  };
  const convertSlotToVal = slot => slots[Number(slot.split(':')[1])];
  return { convertValToSlot, convertSlotToVal };
};

for (const serializeBodyFormat of /** @type {const} */ ([
  'capdata',
  'smallcaps',
])) {
  test(`SturdyRef round-trips through ${serializeBodyFormat}`, async t => {
    const { convertValToSlot, convertSlotToVal } = makeSlotTable();
    const { toCapData, fromCapData } = makeMarshal(
      convertValToSlot,
      convertSlotToVal,
      { serializeBodyFormat },
    );
    const { ref, live } = makeRef('Alice');
    const capData = toCapData(harden({ ref, again: ref, list: [ref] }));
    t.deepEqual(capData.slots, ['sturdyRef:0']);
    const expectedBody =
      serializeBodyFormat === 'capdata'
        ? '{"again":{"@qclass":"sturdyRef","index":0},"list":[{"@qclass":"sturdyRef","index":0}],"ref":{"@qclass":"sturdyRef","index":0}}'
        : `#{"again":"'0","list":["'0"],"ref":"'0"}`;
    t.is(capData.body, expectedBody);

    const decoded = /** @type {any} */ (fromCapData(capData));
    t.is(decoded.ref, ref);
    t.is(decoded.again, ref);
    t.is(decoded.list[0], ref);
    t.is(passStyleOf(decoded.ref), 'sturdyRef');
    const enlivened = await SturdyRef.enliven(decoded.ref);
    t.is(enlivened, live);
  });

  test(`SturdyRef shares the slot table in ${serializeBodyFormat}`, t => {
    const { convertValToSlot, convertSlotToVal } = makeSlotTable();
    const { toCapData, fromCapData } = makeMarshal(
      convertValToSlot,
      convertSlotToVal,
      { serializeBodyFormat },
    );
    const { ref, live } = makeRef('Bob');
    const p = Promise.resolve();
    const capData = toCapData(harden([live, ref, p]));
    t.deepEqual(capData.slots, ['remotable:0', 'sturdyRef:1', 'promise:2']);
    const [dLive, dRef, dP] = /** @type {any} */ (fromCapData(capData));
    t.is(dLive, live);
    t.is(dRef, ref);
    t.is(dP, p);
  });

  test(`${serializeBodyFormat} rejects a non-SturdyRef in a sturdyRef slot`, t => {
    const { live } = makeRef('Carol');
    const { fromCapData } = makeMarshal(undefined, () => live, {
      serializeBodyFormat,
    });
    const body =
      serializeBodyFormat === 'capdata'
        ? '{"@qclass":"sturdyRef","index":0}'
        : `#"'0"`;
    t.throws(() => fromCapData({ body, slots: ['x'] }), {
      message: /must return a sturdyRef/,
    });
  });
}

test('capdata rejects an iface on a sturdyRef', t => {
  const { ref } = makeRef('Dave');
  const { fromCapData } = makeMarshal(undefined, () => ref);
  t.throws(
    () =>
      fromCapData({
        body: '{"@qclass":"sturdyRef","index":0,"iface":"x"}',
        slots: ['x'],
      }),
    { message: /unexpected encoded sturdyRef property "iface"/ },
  );
});

test('a slot decoded as a remotable cannot be reused as a sturdyRef', t => {
  const { live } = makeRef('Eve');
  const { fromCapData } = makeMarshal(undefined, () => live, {
    serializeBodyFormat: 'smallcaps',
  });
  t.throws(
    () => fromCapData({ body: `#["$0.Alleged: Eve","'0"]`, slots: [0] }),
    {
      message: /must return a sturdyRef/,
    },
  );
});

test('the default converters carry a SturdyRef as its own slot', t => {
  // The default converters pass values through, so this only checks that
  // the smallcaps and capdata encoders accept a SturdyRef at all.
  const { ref } = makeRef('Frank');
  const { toCapData } = makeMarshal(undefined, undefined, {
    serializeBodyFormat: 'smallcaps',
  });
  t.deepEqual(toCapData(ref), { body: `#"'0"`, slots: [ref] });
});

test('decodeToJustin renders a sturdyRef', t => {
  const body = { '@qclass': 'sturdyRef', index: 0 };
  t.is(decodeToJustin(harden(body)), 'sturdyRef(0)');
  t.is(decodeToJustin(harden(body), false, ['o-1']), 'sturdyRefToVal("o-1")');
});

test('encodePassable round-trips a SturdyRef', t => {
  const { ref } = makeRef('Grace');
  const refs = [ref];
  for (const format of /** @type {const} */ ([
    'legacyOrdered',
    'compactOrdered',
  ])) {
    const { encodePassable, decodePassable } = makePassableKit({
      format,
      encodeSturdyRef: r => `t${refs.indexOf(r)}`,
      decodeSturdyRef: e => refs[Number(e.slice(1))],
    });
    const encoded = encodePassable(harden([ref, 'x']));
    t.true(encoded.includes('t0'), encoded);
    const decoded = /** @type {any} */ (decodePassable(encoded));
    t.is(decoded[0], ref);
  }
  const { encodePassable } = makePassableKit();
  t.throws(() => encodePassable(ref), { message: /sturdyRef unexpected/ });
  const bad = makePassableKit({ encodeSturdyRef: () => 'r0' });
  t.throws(() => bad.encodePassable(ref), {
    message: /SturdyRef encoding must start with "t"/,
  });
});

test('SturdyRefs rank as a tied category of their own', t => {
  const { ref: a } = makeRef('a');
  const { ref: b } = makeRef('b');
  t.is(passStylePrefixes.sturdyRef, 't');
  t.is(compareRank(a, b), 0);
  // After strings, before null.
  t.true(compareRank('zzz', a) < 0);
  t.true(compareRank(a, null) < 0);
});

test('the dot-membrane passes a SturdyRef as a membraned SturdyRef', async t => {
  const { ref, live } = makeRef('Heidi');
  const { proxy, revoke } = makeDotMembraneKit(
    Far('Holder', { get: () => ref }),
  );
  const yourRef = await proxy.get();
  t.is(passStyleOf(yourRef), 'sturdyRef');
  t.not(yourRef, ref);
  const yourLive = await SturdyRef.enliven(yourRef);
  t.not(yourLive, live);
  t.is(await yourLive.label(), 'Heidi');
  revoke('done');
  await t.throwsAsync(() => SturdyRef.enliven(yourRef), {
    message: /Revoked: done/,
  });
});
