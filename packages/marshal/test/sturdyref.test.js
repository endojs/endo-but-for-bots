// Install the realm's SturdyRef before anything below can make one.
import '@endo/sturdyref/shim.js';
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { passStyleOf } from '@endo/pass-style';

import {
  compareRank,
  getPassStyleCover,
  sortByRank,
} from '../src/rankOrder.js';
import { makeEncodePassable } from '../src/encodePassable.js';
import { makeMarshal } from '../src/marshal.js';

/** @type {any} */
const { SturdyRef } = globalThis;

const makeRef = () => new SturdyRef({ enliven: () => 'revived' });

// Until marshal gives SturdyRefs a representation, a SturdyRef can be neither
// rank-ordered nor encoded. Both must fail with a clear error.

test('a SturdyRef cannot be rank-ordered', t => {
  const ref = makeRef();
  t.is(passStyleOf(ref), 'sturdyRef');
  const message = /"sturdyRef" cannot be rank-ordered/;
  t.throws(() => compareRank(ref, 5), { message });
  t.throws(() => compareRank(5, ref), { message });
  t.throws(() => sortByRank(harden([1, ref]), compareRank), { message });
  t.throws(() => getPassStyleCover('sturdyRef'), { message });
  t.throws(() => compareRank(ref, makeRef()), { message });
});

test('a SturdyRef cannot be encoded', t => {
  const encodePassable = makeEncodePassable();
  t.throws(() => encodePassable(makeRef()), {
    message: /"sturdyRef"/,
  });
});

test('a SturdyRef cannot be marshalled', t => {
  const message = /a "sturdyRef" cannot be marshalled/;
  for (const serializeBodyFormat of /** @type {const} */ ([
    'capdata',
    'smallcaps',
  ])) {
    const { toCapData } = makeMarshal(undefined, undefined, {
      serializeBodyFormat,
    });
    t.throws(() => toCapData(makeRef()), { message }, serializeBodyFormat);
    t.throws(
      () => toCapData(harden({ nested: [makeRef()] })),
      { message },
      serializeBodyFormat,
    );
  }
});
