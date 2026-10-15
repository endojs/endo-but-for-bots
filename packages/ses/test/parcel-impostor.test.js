import './_parcel-impostor.js';
import '../index.js';
import test from 'ava';

test('lockdown refuses a Parcel that is not the shim constructor', t => {
  t.throws(() => lockdown(), {
    instanceOf: TypeError,
    message: /compatible Parcel constructor/,
  });
});
