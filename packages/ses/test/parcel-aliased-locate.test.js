import './_parcel-aliased-locate.js';
import '../index.js';
import test from 'ava';

test('lockdown refuses a Parcel whose open is its locate', t => {
  t.throws(() => lockdown(), {
    instanceOf: TypeError,
    message: /compatible Parcel constructor/,
  });
});
