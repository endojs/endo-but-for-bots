// @ts-nocheck
/* eslint-disable no-await-in-loop, no-underscore-dangle */

import '@endo/init/debug.js';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { getInterfaceGuardPayload } from '@endo/patterns';

import { makeMemoryCas } from '../src/fs/extended/cas.js';
import { withCachedReads } from '../src/fs/extended/cached-fs.js';
import { makeInMemoryFilesystem } from '../src/fs/extended/in-memory.js';
import { readOnly } from '../src/fs/extended/readonly.js';
import {
  DirectoryInterface,
  FileInterface,
  FilesystemInterface,
  OpenFileInterface,
} from '../src/fs/extended/type-guards.js';
import { makeConnectedPair } from './_captp-pair.js';

const userMethodNames = async cap =>
  (await E(cap).__getMethodNames__())
    .filter(name => !name.startsWith('__'))
    .sort();

const declaredMethodNames = guard =>
  Object.keys(getInterfaceGuardPayload(guard).methodGuards).sort();

test('guard schemas reject malformed records and accept tolerant extras', async t => {
  const fs = makeInMemoryFilesystem();
  const root = await E(fs).root();

  await t.throwsAsync(() => E(root).setStat({ size: 'not a bigint' }), {
    message: /In "setStat" method.*bigint/s,
  });

  const openFile = await E(root).create('tolerant', {
    read: true,
    extension: 'ignored by this implementation',
  });
  await E(openFile).close();
});

test('undeclared filesystem methods fail at exo construction', t => {
  const behavior = {
    root() {},
    named() {},
    statfs() {},
    brands() {},
    help() {},
    futureMethod() {},
  };

  t.throws(() => makeExo('Filesystem', FilesystemInterface, behavior), {
    message: /methods \["futureMethod"\] not guarded by "Filesystem"/,
  });
});

test('local and forwarding filesystem wrappers expose exact guard surfaces', async t => {
  const local = makeInMemoryFilesystem();
  const localRoot = await E(local).root();
  const localFile = await E(localRoot).create('guard-file', {});
  await E(localFile).close();
  const { bootstrapRef } = makeConnectedPair(local);
  const wrappers = [
    ['local', local],
    ['read-only local', readOnly(local)],
    ['read-only remote', readOnly(bootstrapRef)],
    ['cached remote', withCachedReads(bootstrapRef, makeMemoryCas())],
  ];

  for (const [label, fs] of wrappers) {
    t.deepEqual(
      await userMethodNames(fs),
      declaredMethodNames(FilesystemInterface),
      `${label} Filesystem methods`,
    );
    const root = await E(fs).root();
    t.deepEqual(
      await userMethodNames(root),
      declaredMethodNames(DirectoryInterface),
      `${label} Directory methods`,
    );
    const qid = await E(root).getQid();
    t.is(qid.type, 'directory', `${label} getQid result is guarded`);
    const file = await E(root).lookup('guard-file');
    t.deepEqual(
      await userMethodNames(file),
      declaredMethodNames(FileInterface),
      `${label} File methods`,
    );
    const openFile = await E(file).open({ read: true });
    t.deepEqual(
      await userMethodNames(openFile),
      declaredMethodNames(OpenFileInterface),
      `${label} OpenFile methods`,
    );
    const fileQid = await E(file).getQid();
    t.is(fileQid.type, 'file', `${label} File getQid result is guarded`);
    await E(openFile).close();
  }
});
