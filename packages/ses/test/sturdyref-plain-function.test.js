import './_sturdyref-plain-function.js';
import '../index.js';
import test from 'ava';

test('lockdown refuses a SturdyRef whose prototype is writable', t => {
  t.throws(() => lockdown(), {
    instanceOf: TypeError,
    message: /@endo\/sturdyref constructor/,
  });
});
