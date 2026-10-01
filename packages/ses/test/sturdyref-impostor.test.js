import './_sturdyref-impostor.js';
import '../index.js';
import test from 'ava';

test('lockdown refuses a SturdyRef that is not the shim constructor', t => {
  t.throws(() => lockdown(), {
    instanceOf: TypeError,
    message: /@endo\/sturdyref constructor/,
  });
});
