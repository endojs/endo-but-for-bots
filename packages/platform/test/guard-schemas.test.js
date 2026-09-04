// @ts-nocheck
/* eslint-disable no-await-in-loop, no-underscore-dangle */

import '@endo/init/debug.js';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import {
  getInterfaceGuardPayload,
  getMethodGuardPayload,
} from '@endo/patterns';

import { makeMemoryCas } from '../src/fs/extended/cas.js';
import { withCachedReads } from '../src/fs/extended/cached-fs.js';
import { makeInMemoryFilesystem } from '../src/fs/extended/in-memory.js';
import { readOnly } from '../src/fs/extended/readonly.js';
import { wrapBackend } from '../src/fs/extended/wrap-backend.js';
import {
  CursorInterface,
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

// ---------- node-specific QID kinds (review finding #1) ----------

/**
 * A minimal read-only backend backing one directory ("") and one file
 * ("f.txt"). Its `qidFor` hook deliberately answers with the *opposite*
 * kind from the one `wrapBackend` asks for, simulating a buggy
 * content-address backend that disagrees with the exo it backs.
 */
const makeWrongKindQidBackend = () => {
  const files = new Map([['f.txt', new Uint8Array()]]);
  return harden({
    async kind(path) {
      if (path.length === 0) return 'directory';
      return files.has(path.join('/')) ? 'file' : undefined;
    },
    async *list(dirPath) {
      if (dirPath.length !== 0) return;
      for (const name of files.keys()) yield harden({ name, kind: 'file' });
    },
    async read() {
      return new Uint8Array();
    },
    async write() {
      throw Error('EROFS');
    },
    async makeDirectory() {
      throw Error('EROFS');
    },
    async remove() {
      throw Error('EROFS');
    },
    qidFor(_path, kind) {
      const wrongKind = kind === 'file' ? 'directory' : 'file';
      return harden({ type: wrongKind, pathId: 1n, version: 0n });
    },
  });
};

test('a directory-kind QID is rejected on a File (wrong discriminator)', async t => {
  const fs = wrapBackend(makeWrongKindQidBackend());
  const root = await E(fs).root();
  const file = await E(root).lookup('f.txt');
  await t.throwsAsync(() => E(file).getQid(), {
    message: /In "getQid" method.*type.*file/s,
  });
});

test('a file-kind QID is rejected on a Directory (wrong discriminator)', async t => {
  const fs = wrapBackend(makeWrongKindQidBackend());
  const root = await E(fs).root();
  await t.throwsAsync(() => E(root).getQid(), {
    message: /In "getQid" method.*type.*directory/s,
  });
});

test("readOnly propagates a wrapped backend's wrong-kind QID rejection", async t => {
  const fs = wrapBackend(makeWrongKindQidBackend());
  const ro = readOnly(fs);
  // The wrapper resolves (and caches) the child's QID as part of
  // `root()`/`lookup()` themselves, so a malformed inner QID surfaces as
  // a rejection there rather than bypassing the boundary silently.
  await t.throwsAsync(() => E(ro).root(), {
    message: /In "getQid" method.*type.*directory/s,
  });
});

// ---------- tolerant lock extension (review finding #2) ----------

test('OpenFile.lock guard has no undeclared `wait` member', t => {
  const { methodGuards } = getInterfaceGuardPayload(OpenFileInterface);
  const { argGuards } = getMethodGuardPayload(methodGuards.lock);
  const [lockOptsShape] = argGuards;
  // A `match:splitRecord` payload is `[base, optional, rest?]`; the
  // optional-fields keys are enough to assert `wait` was intentionally
  // dropped from the guard, not merely renamed.
  const [, optionalShape] = lockOptsShape.payload;
  t.false(Object.keys(optionalShape).includes('wait'));
});

// ---------- async return-guard validation (review finding #3) ----------

const throwStub = name => () => {
  throw Error(`stub: ${name} not implemented`);
};

/** Every declared `Directory` method, stubbed to throw if invoked. */
const stubDirectoryBehavior = () =>
  Object.fromEntries(
    Object.keys(getInterfaceGuardPayload(DirectoryInterface).methodGuards).map(
      name => [name, throwStub(name)],
    ),
  );

test('watchFrom rejects a malformed { cursor, watcher } fulfillment', async t => {
  const cursor = makeExo('Cursor', CursorInterface, {
    read: () => Promise.resolve({ entries: [], atEnd: true }),
    stream: throwStub('stream'),
    toArray: () => Promise.resolve([]),
    skip: () => Promise.resolve(undefined),
    rewind: () => Promise.resolve(undefined),
    close: () => Promise.resolve(undefined),
    help: () => 'cursor',
  });

  const dir = makeExo('Directory', DirectoryInterface, {
    ...stubDirectoryBehavior(),
    getQid: () => harden({ type: 'directory', pathId: 1n, version: 0n }),
    // Malformed: `watcher` is a plain object, not a NodeWatcher
    // remotable — forwarded asynchronously, as every real `watchFrom`
    // implementation is.
    async watchFrom() {
      return harden({ cursor, watcher: {} });
    },
  });

  await t.throwsAsync(() => E(dir).watchFrom(), {
    message: /In "watchFrom" method.*Must be a remotable NodeWatcher/s,
  });
});

// ---------- remote getQid stays synchronous (review finding #4) ----------

test('readOnly: getQid stays synchronous on a remote-backed Directory and File', async t => {
  const fs = makeInMemoryFilesystem();
  const root = await E(fs).root();
  await E(root)
    .create('f', {})
    .then(o => E(o).close());
  await E(root).mkdir('d', {});

  const { bootstrapRef } = makeConnectedPair(fs);
  const ro = readOnly(bootstrapRef);

  // `root()` resolves the remote root's QID as part of pipelining, so
  // the returned wrapper's `getQid()` never needs to forward a promise
  // — it answers from the cache, matching the canonical `Directory`
  // type's synchronous `getQid(): Qid`.
  const rRoot = await E(ro).root();
  const rootQid = rRoot.getQid();
  t.false(rootQid instanceof Promise, 'root getQid is synchronous');
  t.is(rootQid.type, 'directory');

  const rDir = await E(rRoot).lookup('d');
  const dirQid = rDir.getQid();
  t.false(dirQid instanceof Promise, 'lookup(dir) getQid is synchronous');
  t.is(dirQid.type, 'directory');

  const rFile = await E(rRoot).lookup('f');
  const fileQid = rFile.getQid();
  t.false(fileQid instanceof Promise, 'lookup(file) getQid is synchronous');
  t.is(fileQid.type, 'file');
});
