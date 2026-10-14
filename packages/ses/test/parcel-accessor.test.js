import './_parcel-accessor.js';
import '../index.js';
import test from 'ava';

test('lockdown refuses an accessor Parcel global', t => {
  t.throws(() => lockdown(), {
    instanceOf: TypeError,
    message: /Parcel to be a data property/,
  });
});
