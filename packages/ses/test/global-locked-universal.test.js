import './_json-locked-first.js';
import '../index.js';
import test from 'ava';

test('lockdown refuses a universal global locked before lockdown', t => {
  // The engine's redefinition error names the locked property.
  t.throws(() => lockdown(), { instanceOf: TypeError, message: /JSON/ });
});
