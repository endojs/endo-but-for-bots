import './_sturdyref-shim-writable.js';
import '../index.js';
import test from 'ava';

test('lockdown refuses a writable non-configurable SturdyRef', t => {
  // The engine's redefinition error names the locked property.
  t.throws(() => lockdown(), { instanceOf: TypeError, message: /SturdyRef/ });
});
