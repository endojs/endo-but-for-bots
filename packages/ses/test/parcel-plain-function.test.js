import './_parcel-plain-function.js';
import '../index.js';
import test from 'ava';

test('lockdown refuses a Parcel whose prototype is writable', t => {
  t.throws(() => lockdown(), {
    instanceOf: TypeError,
    message: /@endo\/parcel constructor/,
  });
});
