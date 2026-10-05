import './_sturdyref-shim-enumerable.js';
import '../index.js';
import test from 'ava';

test('lockdown refuses a locked SturdyRef of the wrong shape', t => {
  // The redefinition error message is engine-specific; assert only the type.
  t.throws(() => lockdown(), { instanceOf: TypeError });
});
