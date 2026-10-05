import './_sturdyref-shim-writable.js';
import '../index.js';
import test from 'ava';

test('lockdown refuses a writable non-configurable SturdyRef', t => {
  // The redefinition error message is engine-specific; assert only the type.
  t.throws(() => lockdown(), { instanceOf: TypeError });
});
