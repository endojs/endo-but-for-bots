import './_sturdyref-non-function.js';
import '../index.js';
import test from 'ava';

test('lockdown refuses a SturdyRef global that is not a function', t => {
  t.throws(() => lockdown(), {
    instanceOf: TypeError,
    message: /@endo\/sturdyref constructor/,
  });
});
