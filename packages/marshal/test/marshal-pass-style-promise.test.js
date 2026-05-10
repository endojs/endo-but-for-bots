// @ts-check

import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { passStyleOf, makePromise } from '@endo/pass-style';

import { makeMarshal } from '../src/marshal.js';

/**
 * The marshal codecs (capdata and smallcaps) are `passStyleOf`-driven:
 * once `passStyleOf(x) === 'promise'`, both codecs hand the value to the
 * caller's `convertValToSlot` and emit the appropriate slot encoding.
 * The new pass-style promise carrier reports `passStyleOf(x) === 'promise'`,
 * so the codecs need no source change. These tests confirm that the
 * round-trip works in both codecs.
 */

const makeIdentitySlots = () => {
  /** @type {WeakMap<object, string>} */
  const valToSlot = new WeakMap();
  /** @type {Map<string, object>} */
  const slotToVal = new Map();
  let nextSlotIndex = 0;
  /**
   * @param {any} val
   */
  const convertValToSlot = val => {
    let slot = valToSlot.get(val);
    if (slot === undefined) {
      nextSlotIndex += 1;
      slot = `slot${nextSlotIndex}`;
      valToSlot.set(val, slot);
      slotToVal.set(slot, val);
    }
    return slot;
  };
  /**
   * @param {string} slot
   * @param {string} [iface]
   */
  const convertSlotToVal = (slot, iface) => {
    void iface;
    let val = slotToVal.get(slot);
    if (val === undefined) {
      // Unknown slot: synthesize a fresh pass-style promise carrier as
      // the inbound representation. (The codec doesn't know which kind
      // of cap the slot represents; the user's resolver chooses.)
      val = makePromise();
      slotToVal.set(slot, val);
      valToSlot.set(val, slot);
    }
    return val;
  };
  return harden({ convertValToSlot, convertSlotToVal });
};

test('capdata round-trips a pass-style promise as a "promise" slot', t => {
  const { convertValToSlot, convertSlotToVal } = makeIdentitySlots();
  const { serialize, unserialize } = makeMarshal(
    convertValToSlot,
    convertSlotToVal,
    {
      serializeBodyFormat: 'capdata',
      errorTagging: 'off',
    },
  );

  const carrier = makePromise();
  t.is(passStyleOf(carrier), 'promise');

  const ser = serialize(carrier);
  // capdata encodes a single passable cap as a slot reference.
  t.deepEqual(JSON.parse(ser.body), { '@qclass': 'slot', index: 0 });
  t.is(ser.slots.length, 1);

  const observed = unserialize(ser);
  t.is(observed, carrier, 'identity is preserved through round-trip');
  t.is(passStyleOf(observed), 'promise');
});

test('smallcaps round-trips a pass-style promise as a "&N" slot', t => {
  const { convertValToSlot, convertSlotToVal } = makeIdentitySlots();
  const { serialize, unserialize } = makeMarshal(
    convertValToSlot,
    convertSlotToVal,
    {
      serializeBodyFormat: 'smallcaps',
      errorTagging: 'off',
    },
  );

  const carrier = makePromise();
  t.is(passStyleOf(carrier), 'promise');

  const ser = serialize(carrier);
  // smallcaps encodes a promise slot as `&N`.
  t.is(ser.body, '#"&0"');
  t.is(ser.slots.length, 1);

  const observed = unserialize(ser);
  t.is(observed, carrier, 'identity is preserved through round-trip');
  t.is(passStyleOf(observed), 'promise');
});

test('capdata round-trips a record containing a pass-style promise', t => {
  const { convertValToSlot, convertSlotToVal } = makeIdentitySlots();
  const { serialize, unserialize } = makeMarshal(
    convertValToSlot,
    convertSlotToVal,
    {
      serializeBodyFormat: 'capdata',
      errorTagging: 'off',
    },
  );

  const carrier = makePromise();
  const wrapper = harden({ p: carrier, n: 42 });

  const ser = serialize(wrapper);
  t.is(ser.slots.length, 1);
  const observed = /** @type {{ p: object, n: number }} */ (unserialize(ser));
  t.is(observed.p, carrier);
  t.is(observed.n, 42);
});

test('smallcaps round-trips an array of mixed promise kinds', t => {
  const { convertValToSlot, convertSlotToVal } = makeIdentitySlots();
  const { serialize, unserialize } = makeMarshal(
    convertValToSlot,
    convertSlotToVal,
    {
      serializeBodyFormat: 'smallcaps',
      errorTagging: 'off',
    },
  );

  const passStyleCarrier = makePromise();
  const nativePromise = harden(Promise.resolve(null));
  // Both kinds report passStyleOf 'promise'; both encode as &N slots.
  const both = harden([passStyleCarrier, nativePromise, passStyleCarrier]);

  const ser = serialize(both);
  t.is(ser.slots.length, 2, 'two distinct slots, third is a back-reference');

  const observed = /** @type {readonly any[]} */ (unserialize(ser));
  t.is(observed[0], passStyleCarrier);
  t.is(observed[1], nativePromise);
  t.is(observed[2], passStyleCarrier);
});

test('decoder may return a pass-style promise for an inbound slot', t => {
  // The decoder is free to return either a native Promise or a pass-style
  // carrier for an inbound slot; the codecs accept either because both
  // satisfy `passStyleOf(x) === 'promise'`.
  /**
   * @param {string} slot
   */
  const convertSlotToVal = slot => {
    void slot;
    return makePromise();
  };
  /**
   * @param {any} val
   */
  const convertValToSlot = val => {
    void val;
    return 'slot1';
  };
  const { unserialize } = makeMarshal(convertValToSlot, convertSlotToVal, {
    serializeBodyFormat: 'smallcaps',
    errorTagging: 'off',
  });

  const observed = unserialize(harden({ body: '#"&0"', slots: ['slot1'] }));
  t.is(passStyleOf(observed), 'promise');
});
