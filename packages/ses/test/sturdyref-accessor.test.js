import './_sturdyref-accessor.js';
import '../index.js';
import test from 'ava';

test('lockdown refuses an accessor SturdyRef global', t => {
  t.throws(() => lockdown(), {
    instanceOf: TypeError,
    message: /SturdyRef to be a data property/,
  });
});
