// @ts-nocheck
/* eslint-disable import/order */

/**
 * Filesystem authority posture: which composed and adapted `Filesystem` caps
 * a trusted consumer may treat as writable.
 *
 * The posture facets are the only claim `isFilesystemReadWrite()` honors, so
 * every construction that cannot prove writable authority for the whole view
 * must decline to assert it rather than infer it.
 */

import '@endo/init/debug.js';

import test from 'ava';
import { E } from '@endo/eventual-send';

import { makeInMemoryFilesystem } from '../src/fs/extended/in-memory.js';
import { readOnly } from '../src/fs/extended/readonly.js';
import { mountAsFilesystem } from '../src/fs/extended/from-mount.js';
import { chroot, namespace } from '../src/fs/extended/compose.js';
import {
  isFilesystemReadOnly,
  isFilesystemReadWrite,
} from '../src/fs/extended/posture.js';

/**
 * A minimal in-vat stand-in for a daemon Mount: it answers the Mount surface
 * `makeFromMountBackend` uses, and — like a real read-only mount — rejects
 * mutation at its own boundary rather than at the adapter's.
 */
const makeStubMount = () => ({
  async list() {
    return harden([]);
  },
  async has() {
    return false;
  },
  async stat() {
    return harden({ type: 'directory' });
  },
  async writeText() {
    throw new Error('EACCES: read-only mount');
  },
  help() {
    return 'stub mount';
  },
});

test('mountAsFilesystem does not infer writable authority from the adapter', t => {
  const fs = mountAsFilesystem(makeStubMount());
  // The mount, not this wrapper, holds whatever write authority exists.
  t.false(isFilesystemReadWrite(fs));
  t.false(isFilesystemReadOnly(fs));
});

test('mountAsFilesystem carries a posture the minter states', t => {
  const reader = mountAsFilesystem(makeStubMount(), { posture: 'readOnly' });
  t.true(isFilesystemReadOnly(reader));
  t.false(isFilesystemReadWrite(reader));

  const writer = mountAsFilesystem(makeStubMount(), { posture: 'readWrite' });
  t.true(isFilesystemReadWrite(writer));
  t.false(isFilesystemReadOnly(writer));
});

test('chroot preserves a uniform posture', async t => {
  const writable = makeInMemoryFilesystem();
  await E(await E(writable).root()).makeDirectory('sub');
  t.true(isFilesystemReadWrite(chroot(writable, ['sub'])));

  const reader = readOnly(writable);
  const narrowedReader = chroot(reader, ['sub']);
  t.true(isFilesystemReadOnly(narrowedReader));
  t.false(isFilesystemReadWrite(narrowedReader));
});

test('chroot of a mixed namespace does not inherit aggregate writability', async t => {
  const writable = makeInMemoryFilesystem();
  const reader = readOnly(makeInMemoryFilesystem());
  const mixed = namespace({ rw: writable, ro: reader });

  // The namespace as a whole does hold write authority — somewhere.
  t.true(isFilesystemReadWrite(mixed));

  // But the read-only subtree does not, so the narrowed view must not claim
  // writable authority the guest cannot exercise.
  const narrowed = chroot(mixed, ['ro']);
  t.false(isFilesystemReadWrite(narrowed));
  t.false(isFilesystemReadOnly(narrowed));

  // The narrowing is conservative rather than subtree-specific: the writable
  // leg is treated the same way, since posture is not path-resolved.
  t.false(isFilesystemReadWrite(chroot(mixed, ['rw'])));
});

test('a uniformly read-only namespace narrows to read-only', t => {
  const a = readOnly(makeInMemoryFilesystem());
  const b = readOnly(makeInMemoryFilesystem());
  const both = namespace({ a, b });
  t.true(isFilesystemReadOnly(both));
  t.true(isFilesystemReadOnly(chroot(both, ['a'])));
});

test('a uniformly writable namespace keeps writable posture through chroot', t => {
  const a = makeInMemoryFilesystem();
  const b = makeInMemoryFilesystem();
  const both = namespace({ a, b });
  t.true(isFilesystemReadWrite(both));
  t.true(isFilesystemReadWrite(chroot(both, ['a'])));
});
