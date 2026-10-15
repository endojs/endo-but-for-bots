import test from 'ava';
import { open, locate } from './_parcel-proxy-open.js';
import '../index.js';

lockdown();

test('the shared Parcel uses the descriptor-validated open, not a Proxy get', t => {
  const shared = new Compartment().globalThis.Parcel;
  t.is(shared.open, open);
  t.not(shared.open, locate);
  t.false(Object.hasOwn(shared, 'locate'));
});
