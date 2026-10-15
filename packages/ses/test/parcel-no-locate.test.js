import './_parcel-no-locate.js';
import '../index.js';
import test from 'ava';

test('lockdown refuses a Parcel without locate', t => {
  t.throws(() => lockdown(), {
    instanceOf: TypeError,
    message: /compatible Parcel constructor/,
  });
});
