import './_json-locked-first.js';
import '../index.js';
import test from 'ava';

test('lockdown refuses a universal global locked before lockdown', t => {
  // The redefinition error message is engine-specific; assert only the type.
  t.throws(() => lockdown(), { instanceOf: TypeError });
});
