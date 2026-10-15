import './_parcel-shim-writable.js';
import '../index.js';
import test from 'ava';

test('lockdown refuses a writable non-configurable Parcel', t => {
  t.throws(() => lockdown(), { instanceOf: TypeError });
});
