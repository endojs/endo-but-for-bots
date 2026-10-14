// Install the realm's Parcel before anything below can make one.
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

const makeRef = () => new Parcel('test:patterns', () => 'opened');

// A Parcel is passable but, like a promise or an error, is neither a key
// nor a pattern. Predicates must answer false, and assertions must say so,
// rather than fail with an internal error.

parcelTest('a Parcel is not a key', t => {
  const ref = makeRef();
  t.is(passStyleOf(ref), 'parcel');
  t.false(isKey(ref));
  t.false(isKey(harden([ref])));
  t.false(isKey(harden({ ref })));
  const message = /"parcel" cannot be a key/;
  t.throws(() => assertKey(ref), { message });
  t.throws(() => keyEQ(ref, ref), { message });
});

parcelTest('a Parcel is not a pattern', t => {
  const ref = makeRef();
  t.false(isPattern(ref));
  t.false(isPattern(harden([ref])));
  t.false(matches(5, ref));
  t.throws(() => mustMatch(5, ref), {
    message: /parcels cannot be patterns/,
  });
});

parcelTest('a Parcel cannot bound a range pattern', t => {
  // Range matchers look up a rank cover, which a Parcel does not have.
  // They must reject it as a non-key when the pattern is made.
  const ref = makeRef();
  const message = /"parcel" cannot be a key/;
  t.throws(() => M.lte(ref), { message });
  t.throws(() => M.gte(ref), { message });
  t.throws(() => M.lt(ref), { message });
  t.throws(() => M.gt(ref), { message });
});

parcelTest('a Parcel as a specimen fails to match rather than throwing', t => {
  const ref = makeRef();
  t.true(matches(ref, M.any()));
  t.false(matches(ref, M.key()));
  t.false(matches(ref, M.scalar()));
  t.false(matches(ref, M.remotable()));
  t.false(matches(ref, 3));
  t.false(matches(harden({ ref }), M.key()));
  t.false(matches(harden({ ref }), harden({ ref: M.key() })));
  t.true(matches(harden({ ref }), harden({ ref: M.any() })));
});

parcelTest('a Parcel has no rank cover', t => {
  const encodePassable = makeEncodePassable();
  t.throws(() => getRankCover(makeRef(), encodePassable), {
    message: /"parcel" cannot be rank-ordered/,
  });
});
