// Run only by test/snapshot-roundtrip.test.js, in a child ava process.
// The @endo/init import must stay: it replaces the global Uint8Array after
// ava has loaded (see the comment in .yarn/patches/ava-npm-8.0.1-*.patch).
import '../../debug.js';
import test from 'ava';

test('snapshot under @endo/init', t => {
  t.snapshot([{ a: 1 }, 'text', [1, 2, 3], new Uint8Array([1, 2, 3])]);
});
