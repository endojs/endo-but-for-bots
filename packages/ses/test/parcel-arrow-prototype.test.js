import './_parcel-arrow-prototype.js';
import '../index.js';
import test from 'ava';

test('lockdown refuses a non-constructor Parcel with a locked prototype', t => {
  t.throws(() => lockdown(), {
    instanceOf: TypeError,
    message: /compatible Parcel constructor/,
  });
});
