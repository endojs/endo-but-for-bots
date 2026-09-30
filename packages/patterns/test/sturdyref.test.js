// Install the realm's SturdyRef before anything below can make one.
import '@endo/sturdyref/shim.js';
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { Far } from '@endo/pass-style';

import { isKey, assertKey } from '../src/keys/checkKey.js';
import {
  isPattern,
  assertPattern,
  matches,
  M,
} from '../src/patterns/patternMatchers.js';

/** @type {any} */
const { SturdyRef } = globalThis;

const makeRef = () => {
  const live = Far('Alice', {});
  return new SturdyRef(harden({ enliven: () => live }));
};

test('a SturdyRef is not a key', t => {
  const ref = makeRef();
  t.false(isKey(ref));
  t.false(isKey(harden({ ref })));
  t.false(isKey(harden([ref])));
  t.throws(() => assertKey(ref), { message: /"sturdyRef" cannot be a key/ });
});

test('a SturdyRef is not a pattern', t => {
  const ref = makeRef();
  t.false(isPattern(ref));
  t.false(isPattern(harden({ ref })));
  t.throws(() => assertPattern(ref), {
    message: /"sturdyRef" cannot be a pattern/,
  });
  t.false(matches(1, ref));
});

test('a SturdyRef matches M.any() but no key pattern', t => {
  const ref = makeRef();
  t.true(matches(ref, M.any()));
  t.true(matches(harden({ ref }), M.record()));
  t.false(matches(ref, M.remotable()));
  t.false(matches(ref, M.promise()));
  t.false(matches(ref, M.key()));
});
