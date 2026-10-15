import test from 'ava';
import { getterCalls } from './_parcel-accessor-static.js';
import '../index.js';

test('lockdown refuses an accessor static without invoking it', t => {
  t.throws(() => lockdown(), {
    instanceOf: TypeError,
    message: /compatible Parcel constructor/,
  });
  t.is(getterCalls.count, 0);
});
