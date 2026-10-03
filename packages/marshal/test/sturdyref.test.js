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
// enlivens a sturdyRef to a presence it closes over.
const makeSturdyRef = label => {
  const live = Far(label, { label: () => label });
  const sturdyRef = new SturdyRef(harden({ enliven: () => live }));
  return { sturdyRef, live };
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
    const { sturdyRef, live } = makeSturdyRef('Alice');
    const capData = toCapData(
      harden({ sturdyRef, again: sturdyRef, list: [sturdyRef] }),
    );
    t.deepEqual(capData.slots, ['sturdyRef:0']);
    const expectedBody =
      serializeBodyFormat === 'capdata'
        ? '{"again":{"@qclass":"sturdyRef","index":0},"list":[{"@qclass":"sturdyRef","index":0}],"sturdyRef":{"@qclass":"sturdyRef","index":0}}'
        : `#{"again":"'0","list":["'0"],"sturdyRef":"'0"}`;
    t.is(capData.body, expectedBody);

    const decoded = /** @type {any} */ (fromCapData(capData));
    t.is(decoded.sturdyRef, sturdyRef);
    t.is(decoded.again, sturdyRef);
    t.is(decoded.list[0], sturdyRef);
    t.is(passStyleOf(decoded.sturdyRef), 'sturdyRef');
    const enlivened = await SturdyRef.enliven(decoded.sturdyRef);
    t.is(enlivened, live);
  });

  test(`SturdyRef shares the slot table in ${serializeBodyFormat}`, t => {
    const { convertValToSlot, convertSlotToVal } = makeSlotTable();
    const { toCapData, fromCapData } = makeMarshal(
      convertValToSlot,
      convertSlotToVal,
      { serializeBodyFormat },
    );
    const { sturdyRef, live } = makeSturdyRef('Bob');
    const p = Promise.resolve();
    const capData = toCapData(harden([live, sturdyRef, p]));
    t.deepEqual(capData.slots, ['remotable:0', 'sturdyRef:1', 'promise:2']);
    const [decodedLive, decodedRef, decodedPromise] = /** @type {any} */ (
      fromCapData(capData)
    );
    t.is(decodedLive, live);
    t.is(decodedRef, sturdyRef);
    t.is(decodedPromise, p);
  });

  test(`${serializeBodyFormat} rejects a non-SturdyRef in a sturdyRef slot`, t => {
    const { live } = makeSturdyRef('Carol');
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
  const { sturdyRef } = makeSturdyRef('Dave');
  const { fromCapData } = makeMarshal(undefined, () => sturdyRef);
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
  const { live } = makeSturdyRef('Eve');
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

// Every ordered pair of slot kinds that includes a SturdyRef, since the
// decoder's slot cache is keyed only by index and shared among the kinds.
{
  const smallcapsEncodings = {
    remotable: '"$0.Alleged: Oscar"',
    promise: '"&0"',
    sturdyRef: `"'0"`,
  };
  const makeSlotValue = kind => {
    const { sturdyRef, live } = makeSturdyRef('Oscar');
    if (kind === 'remotable') return live;
    if (kind === 'promise') return harden(Promise.resolve());
    return sturdyRef;
  };
  const kinds = Object.keys(smallcapsEncodings);
  const pairs = kinds.flatMap(first =>
    kinds
      .filter(second => second !== first)
      .filter(second => first === 'sturdyRef' || second === 'sturdyRef')
      .map(second => [first, second]),
  );
  for (const [first, second] of pairs) {
    test(`smallcaps cannot reuse a ${first} slot as a ${second}`, t => {
      const value = makeSlotValue(first);
      const { fromCapData } = makeMarshal(undefined, () => value, {
        serializeBodyFormat: 'smallcaps',
      });
      const body = `#[${smallcapsEncodings[first]},${smallcapsEncodings[second]}]`;
      t.throws(() => fromCapData({ body, slots: [0] }), {
        message: new RegExp(`must return a ${second}`),
      });
    });
  }
}

test('capdata cannot reuse a sturdyRef slot as a plain slot', t => {
  const { sturdyRef } = makeSturdyRef('Mallory');
  const { fromCapData } = makeMarshal(undefined, () => sturdyRef);
  const body = JSON.stringify([
    { '@qclass': 'sturdyRef', index: 0 },
    { '@qclass': 'slot', index: 0, iface: 'Alleged: Mallory' },
  ]);
  t.throws(() => fromCapData({ body, slots: [0] }), {
    message: /a sturdyRef cannot be decoded as a slot/,
  });
});

test('capdata rejects a SturdyRef in a plain slot', t => {
  const { sturdyRef } = makeSturdyRef('Trudy');
  const { fromCapData } = makeMarshal(undefined, () => sturdyRef);
  t.throws(
    () =>
      fromCapData({
        body: '{"@qclass":"slot","index":0,"iface":"Alleged: Trudy"}',
        slots: [0],
      }),
    { message: /a sturdyRef cannot be decoded as a slot/ },
  );
});

test('capdata cannot reuse a plain slot as a sturdyRef', t => {
  const { live } = makeSturdyRef('Walter');
  const { fromCapData } = makeMarshal(undefined, () => live);
  const body = JSON.stringify([
    { '@qclass': 'slot', index: 0, iface: 'Alleged: Walter' },
    { '@qclass': 'sturdyRef', index: 0 },
  ]);
  t.throws(() => fromCapData({ body, slots: [0] }), {
    message: /must return a sturdyRef/,
  });
});

test('the dot-membrane passes an enliven rejection across', async t => {
  const secret = Far('secret', { reveal: () => 'mine' });
  const sturdyRef = new SturdyRef(
    harden({ enliven: () => Promise.reject(secret) }),
  );
  const { proxy, revoke } = makeDotMembraneKit(
    Far('Holder', { get: () => sturdyRef }),
  );
  const yourRef = await proxy.get();
  const reason = await SturdyRef.enliven(yourRef).then(
    () => t.fail('enliven should reject'),
    r => r,
  );
  t.not(reason, secret);
  t.is(passStyleOf(reason), 'remotable');
  t.is(await reason.reveal(), 'mine');
  revoke('done');
});

test('the default converters carry a SturdyRef as its own slot', t => {
  // The default converters pass values through, so this only checks that
  // the smallcaps and capdata encoders accept a SturdyRef at all.
  const { sturdyRef } = makeSturdyRef('Frank');
  const { toCapData } = makeMarshal(undefined, undefined, {
    serializeBodyFormat: 'smallcaps',
  });
  t.deepEqual(toCapData(sturdyRef), { body: `#"'0"`, slots: [sturdyRef] });
});

test('decodeToJustin renders a sturdyRef', t => {
  const body = { '@qclass': 'sturdyRef', index: 0 };
  t.is(decodeToJustin(harden(body)), 'sturdyRef(0)');
  t.is(decodeToJustin(harden(body), false, ['o-1']), 'sturdyRefToVal("o-1")');
});

test('encodePassable round-trips a SturdyRef', t => {
  const { sturdyRef } = makeSturdyRef('Grace');
  const refs = [sturdyRef];
  for (const format of /** @type {const} */ ([
    'legacyOrdered',
    'compactOrdered',
  ])) {
    const { encodePassable, decodePassable } = makePassableKit({
      format,
      encodeSturdyRef: r => `t${refs.indexOf(r)}`,
      decodeSturdyRef: e => refs[Number(e.slice(1))],
    });
    const encoded = encodePassable(harden([sturdyRef, 'x']));
    t.true(encoded.includes('t0'), encoded);
    const decoded = /** @type {any} */ (decodePassable(encoded));
    t.is(decoded[0], sturdyRef);
  }
  const { encodePassable } = makePassableKit();
  t.throws(() => encodePassable(sturdyRef), {
    message: /sturdyRef unexpected/,
  });
  const bad = makePassableKit({ encodeSturdyRef: () => 'r0' });
  t.throws(() => bad.encodePassable(sturdyRef), {
    message: /SturdyRef encoding must start with "t"/,
  });
});

test('SturdyRefs rank as a tied category of their own', t => {
  const { sturdyRef: a } = makeSturdyRef('a');
  const { sturdyRef: b } = makeSturdyRef('b');
  t.is(passStylePrefixes.sturdyRef, 't');
  t.is(compareRank(a, b), 0);
  // After strings, before null.
  t.true(compareRank('zzz', a) < 0);
  t.true(compareRank(a, null) < 0);
});

test('the dot-membrane passes a SturdyRef as a membraned SturdyRef', async t => {
  const { sturdyRef, live } = makeSturdyRef('Heidi');
  const { proxy, revoke } = makeDotMembraneKit(
    Far('Holder', { get: () => sturdyRef }),
  );
  const yourRef = await proxy.get();
  t.is(passStyleOf(yourRef), 'sturdyRef');
  t.not(yourRef, sturdyRef);
  const yourLive = await SturdyRef.enliven(yourRef);
  t.not(yourLive, live);
  t.is(await yourLive.label(), 'Heidi');
  revoke('done');
  await t.throwsAsync(() => SturdyRef.enliven(yourRef), {
    message: /Revoked: done/,
  });
});

test('the dot-membrane passes a synchronous enliven throw across', async t => {
  const secret = Far('secret', { reveal: () => 'mine' });
  const sturdyRef = new SturdyRef(
    harden({
      enliven: () => {
        throw secret;
      },
    }),
  );
  const { proxy, revoke } = makeDotMembraneKit(
    Far('Holder', { get: () => sturdyRef }),
  );
  const yourRef = await proxy.get();
  const reason = await SturdyRef.enliven(yourRef).then(
    () => t.fail('enliven should reject'),
    r => r,
  );
  t.not(reason, secret);
  t.is(passStyleOf(reason), 'remotable');
  t.is(await reason.reveal(), 'mine');
  revoke('done');
});

test('smallcaps rejects a non-canonical sturdyRef index', t => {
  const { sturdyRef } = makeSturdyRef('Ivan');
  const { fromCapData } = makeMarshal(undefined, () => sturdyRef, {
    serializeBodyFormat: 'smallcaps',
  });
  for (const encoding of ["'", "' 0", "'0x0", "'0e0", "'00", "'3.Foo"]) {
    t.throws(
      () => fromCapData({ body: `#${JSON.stringify(encoding)}`, slots: [0] }),
      { message: /sturdyRef encoding must be "'" followed by a slot index/ },
      encoding,
    );
  }
});

test('smallcaps still escapes a plain string that starts with "\'"', t => {
  const { toCapData, fromCapData } = makeMarshal(undefined, undefined, {
    serializeBodyFormat: 'smallcaps',
  });
  const capData = toCapData("'0");
  t.deepEqual(capData, { body: `#"!'0"`, slots: [] });
  t.is(fromCapData(capData), "'0");
});
