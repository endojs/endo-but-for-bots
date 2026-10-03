import './_sturdyref-arrow.js';
import '../index.js';
import test from 'ava';

test('lockdown refuses a SturdyRef with the statics but no prototype', t => {
  t.throws(() => lockdown(), {
    instanceOf: TypeError,
    message: /@endo\/sturdyref constructor/,
  });
});
