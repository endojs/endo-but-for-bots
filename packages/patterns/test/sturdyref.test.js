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

const makeSturdyRef = () => {
  const live = Far('Alice', {});
  return new SturdyRef(harden({ enliven: () => live }));
};

test('a SturdyRef is not a key', t => {
  const sturdyRef = makeSturdyRef();
  t.false(isKey(sturdyRef));
  t.false(isKey(harden({ sturdyRef })));
  t.false(isKey(harden([sturdyRef])));
  t.throws(() => assertKey(sturdyRef), {
    message: /"sturdyRef" cannot be a key/,
  });
});

test('a SturdyRef is not a pattern', t => {
  const sturdyRef = makeSturdyRef();
  t.false(isPattern(sturdyRef));
  t.false(isPattern(harden({ sturdyRef })));
  t.throws(() => assertPattern(sturdyRef), {
    message: /"sturdyRef" cannot be a pattern/,
  });
  t.false(matches(1, sturdyRef));
});

test('a SturdyRef matches M.any() but no key pattern', t => {
  const sturdyRef = makeSturdyRef();
  t.true(matches(sturdyRef, M.any()));
  t.true(matches(harden({ sturdyRef }), M.record()));
  t.false(matches(sturdyRef, M.remotable()));
  t.false(matches(sturdyRef, M.promise()));
  t.false(matches(sturdyRef, M.key()));
});
