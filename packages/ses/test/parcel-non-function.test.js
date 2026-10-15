import './_parcel-non-function.js';
import '../index.js';
import test from 'ava';

test('lockdown refuses a Parcel global that is not a function', t => {
  t.throws(() => lockdown(), {
    instanceOf: TypeError,
    message: /compatible Parcel constructor/,
  });
});
