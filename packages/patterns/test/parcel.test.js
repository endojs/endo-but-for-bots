import '@endo/parcel/shim.js';
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { passStyleOf } from '@endo/pass-style';
import { makeEncodePassable } from '@endo/marshal';

import { isKey, assertKey } from '../src/keys/checkKey.js';
import { keyEQ } from '../src/keys/compareKeys.js';
import {
  isPattern,
  matches,
  mustMatch,
  M,
  getRankCover,
} from '../src/patterns/patternMatchers.js';

/** @type {any} */
const { Parcel } = globalThis;
const parcelTest = Object.isFrozen(Parcel) ? test : test.skip;

const makeParcel = () => new Parcel('test:patterns', () => 'opened');

// A Parcel is passable but, like a promise or an error, is neither a key
// nor a pattern. Predicates must answer false, and assertions must say so,
// rather than fail with an internal error.

parcelTest('a Parcel is not a key', t => {
  const parcel = makeParcel();
  t.is(passStyleOf(parcel), 'parcel');
  t.false(isKey(parcel));
  t.false(isKey(harden([parcel])));
  t.false(isKey(harden({ parcel })));
  const message = /"parcel" cannot be a key/;
  t.throws(() => assertKey(parcel), { message });
  t.throws(() => keyEQ(parcel, parcel), { message });
});

parcelTest('a Parcel is not a pattern', t => {
  const parcel = makeParcel();
  t.false(isPattern(parcel));
  t.false(isPattern(harden([parcel])));
  t.false(matches(5, parcel));
  t.throws(() => mustMatch(5, parcel), {
    message: /parcels cannot be patterns/,
  });
});

parcelTest('a Parcel cannot bound a range pattern', t => {
  // Range matchers look up a rank cover, which a Parcel does not have.
  // They must reject it as a non-key when the pattern is made.
  const parcel = makeParcel();
  const message = /"parcel" cannot be a key/;
  t.throws(() => M.lte(parcel), { message });
  t.throws(() => M.gte(parcel), { message });
  t.throws(() => M.lt(parcel), { message });
  t.throws(() => M.gt(parcel), { message });
});

parcelTest('a Parcel as a specimen fails to match rather than throwing', t => {
  const parcel = makeParcel();
  t.true(matches(parcel, M.any()));
  t.false(matches(parcel, M.key()));
  t.false(matches(parcel, M.scalar()));
  t.false(matches(parcel, M.remotable()));
  t.false(matches(parcel, 3));
  t.false(matches(harden({ parcel }), M.key()));
  t.false(matches(harden({ parcel }), harden({ parcel: M.key() })));
  t.true(matches(harden({ parcel }), harden({ parcel: M.any() })));
});

parcelTest('a Parcel has no rank cover', t => {
  const encodePassable = makeEncodePassable();
  t.throws(() => getRankCover(makeParcel(), encodePassable), {
    message: /"parcel" cannot be rank-ordered/,
  });
});
