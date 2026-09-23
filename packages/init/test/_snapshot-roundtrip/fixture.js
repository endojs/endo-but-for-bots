// Run only by test/snapshot-roundtrip.test.js, in a child ava process.
// Loading @endo/init replaces the global Uint8Array with the
// immutable-arraybuffer view emulation after ava has registered its
// snapshot encoders, which once made ava write snapshot data as a CBOR map
// that it could not read back.
import '../../debug.js';
import test from 'ava';

test('snapshot under @endo/init', t => {
  t.snapshot([{ a: 1 }, 'text', [1, 2, 3]]);
});
