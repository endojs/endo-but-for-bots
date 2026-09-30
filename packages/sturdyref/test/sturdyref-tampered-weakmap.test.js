// @ts-nocheck
/* eslint-disable no-extend-native -- the test tampers with WeakMap.prototype on purpose */
// The ponyfill is usable without lockdown, where `WeakMap.prototype` is
// mutable. The shim captures the WeakMap methods it uses at module load, so
// later tampering cannot exfiltrate a ref's handler or forge the brand.
// Isolated in its own file (its own process) because it never locks down.

import test from 'ava';
import { makeSturdyRef, enliven, isSturdyRef } from '../src/sturdyref-pony.js';

test('tampering with WeakMap.prototype after import reaches nothing', async t => {
  const handler = { enliven: () => 'live' };
  const ref = makeSturdyRef(handler);

  const seen = [];
  const { get, has, set } = WeakMap.prototype;
  WeakMap.prototype.get = function tamperedGet(key) {
    seen.push(this);
    return Reflect.apply(get, this, [key]);
  };
  WeakMap.prototype.has = () => true;
  WeakMap.prototype.set = function tamperedSet(key, value) {
    seen.push(this);
    return Reflect.apply(set, this, [key, value]);
  };
  // Restore before asserting: ava itself uses WeakMaps.
  let enlivened;
  let freshIsBranded;
  let forgedIsBranded;
  try {
    enlivened = await enliven(ref);
    freshIsBranded = isSturdyRef(makeSturdyRef(handler));
    forgedIsBranded = isSturdyRef({});
  } finally {
    Object.assign(WeakMap.prototype, { get, has, set });
  }
  t.is(enlivened, 'live');
  t.true(freshIsBranded);
  t.false(forgedIsBranded, 'a tampered has cannot forge the brand');
  t.is(seen.length, 0, 'the handler map was never exposed');
});
