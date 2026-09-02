import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { passStyleOf } from '../src/passStyleOf.js';

test('passStyleOf recognizes frozen Uint8Array on immutable ArrayBuffer', t => {
  const buf = new ArrayBuffer(4);
  const view = new Uint8Array(buf);
  view[0] = 0xde;
  view[1] = 0xad;
  view[2] = 0xbe;
  view[3] = 0xef;
  const immutable = buf.sliceToImmutable();
  const bytes = harden(new Uint8Array(immutable));
  t.is(/** @type {string} */ (passStyleOf(bytes)), 'byteArray');
});

test('passStyleOf byteArray with empty buffer', t => {
  const buf = new ArrayBuffer(0);
  const immutable = buf.sliceToImmutable();
  const bytes = harden(new Uint8Array(immutable));
  t.is(/** @type {string} */ (passStyleOf(bytes)), 'byteArray');
});
