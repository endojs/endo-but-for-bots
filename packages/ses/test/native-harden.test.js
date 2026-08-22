import test from 'ava';
import { mockHarden, mockHardened } from './_harden-mockery.js';
import { assertFakeFrozen } from './_lockdown-harden-unsafe.js';

test('mocked globalThis.harden', t => {
  t.is(harden, mockHarden);
  t.is(harden.isFake, true);

  const obj = {};
  t.false(mockHardened.has(obj));
  assertFakeFrozen(t, obj);

  harden(obj);
  t.true(mockHardened.has(obj));
  assertFakeFrozen(t, obj);
});
