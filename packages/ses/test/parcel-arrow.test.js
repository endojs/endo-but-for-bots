import './_parcel-arrow.js';
import '../index.js';
import test from 'ava';

test('lockdown refuses a Parcel with the statics but no prototype', t => {
  t.throws(() => lockdown(), {
    instanceOf: TypeError,
    message: /compatible Parcel constructor/,
  });
});
