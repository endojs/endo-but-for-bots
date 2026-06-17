// @ts-nocheck
/* eslint-disable import/order */

import '@endo/init';
import test from 'ava';

import { parseQemuVersion, detectQemuVersion } from '../src/qemu/spawner.js';

test('parseQemuVersion: modern Homebrew output', t => {
  const v = parseQemuVersion(
    'QEMU emulator version 10.2.0\nCopyright (c) 2003-2024 ...\n',
  );
  t.deepEqual(v, { major: 10, minor: 2, patch: 0 });
});

test('parseQemuVersion: Debian/Ubuntu-tagged output', t => {
  const v = parseQemuVersion(
    'QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.16)\n',
  );
  t.deepEqual(v, { major: 8, minor: 2, patch: 2 });
});

test('parseQemuVersion: nothing parseable returns undefined', t => {
  t.is(parseQemuVersion(''), undefined);
  t.is(parseQemuVersion('qemu-system-x86_64: not found'), undefined);
});

test('detectQemuVersion: a missing binary returns undefined (no throw)', t => {
  // Cache is keyed on the binary path; a unique unlikely name avoids
  // contaminating other tests' cache entries.
  const v = detectQemuVersion(
    `/nonexistent/qemu-system-cot-test-${Math.random().toString(36).slice(2)}`,
  );
  t.is(v, undefined);
});
