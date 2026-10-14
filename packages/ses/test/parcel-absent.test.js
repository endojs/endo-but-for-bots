import '../index.js';
import test from 'ava';

lockdown();

test('no Parcel appears when the shim did not run', t => {
  t.false(Object.hasOwn(globalThis, 'Parcel'));
  const c = new Compartment();
  t.false(Object.hasOwn(c.globalThis, 'Parcel'));
  t.is(c.evaluate('typeof Parcel'), 'undefined');
});
