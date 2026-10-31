// Without a visible constructor, the shim cannot install one after lockdown.
// Own file (own process) so lockdown without the shim is isolated.

import 'ses';
import test from 'ava';
import { selectParcel } from '../src/parcel-shim.js';

lockdown();

test('installing after lockdown without a visible constructor throws', t => {
  t.false(Object.hasOwn(globalThis, 'Parcel'));
  t.throws(() => selectParcel(), {
    instanceOf: TypeError,
    message: /must install Parcel before lockdown/,
  });
  t.false(Object.hasOwn(globalThis, 'Parcel'));
});
