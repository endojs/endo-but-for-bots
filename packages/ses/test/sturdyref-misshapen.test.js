import './_sturdyref-shim-enumerable.js';
import '../index.js';
import test from 'ava';

test('lockdown refuses a locked SturdyRef of the wrong shape', t => {
  // The engine's redefinition error names the locked property.
  t.throws(() => lockdown(), { instanceOf: TypeError, message: /SturdyRef/ });
});
