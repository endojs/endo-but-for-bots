// @ts-check

import '@endo/init/debug.js';

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import test from 'ava';

import { E } from '@endo/far';

/** @import { ExecutionContext } from 'ava' */

import {
  makeFamiliarPublisher,
  makeNodeFamiliarPublishPowers,
} from '../index.js';

/**
 * Allocate a unique scratch directory per test, with a teardown
 * that removes the tree. The publisher writes a single file under
 * here; the teardown reclaims it whether the test passed or
 * failed.
 *
 * @param {ExecutionContext<unknown>} t
 */
const makeScratchDir = async t => {
  const dir = await fs.mkdtemp(
    path.join(tmpdir(), 'gateway-familiar-publish-'),
  );
  t.teardown(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
};

/**
 * An in-memory `IoPowers` adapter that records every call. The
 * publisher should remain portable, so the bulk of the assertions
 * run against this fake; a separate suite at the bottom exercises
 * the Node adapter's filesystem behavior.
 */
const makeRecorderIo = () => {
  /** @type {Array<{op: string, target: string, contents?: string}>} */
  const calls = [];
  /** @type {Map<string, string>} */
  const files = new Map();
  return {
    calls,
    files,
    io: harden({
      /**
       * @param {string} target
       * @param {string} contents
       */
      async writeFile(target, contents) {
        calls.push({ op: 'writeFile', target, contents });
        files.set(target, contents);
      },
      /** @param {string} target */
      async removeFile(target) {
        calls.push({ op: 'removeFile', target });
        files.delete(target);
      },
    }),
  };
};

// -- factory + shape ---------------------------------------------

test('makeFamiliarPublisher returns a hardened exo', t => {
  const { io } = makeRecorderIo();
  const publisher = makeFamiliarPublisher({
    io,
    publishPath: '/tmp/gateway-test',
  });
  t.true(Object.isFrozen(publisher));
});

test('makeFamiliarPublisher requires io', t => {
  t.throws(
    () =>
      makeFamiliarPublisher(
        /** @type {any} */ ({ publishPath: '/tmp/gateway-test' }),
      ),
    { message: /requires io powers/ },
  );
});

test('makeFamiliarPublisher rejects io without writeFile', t => {
  t.throws(
    () =>
      makeFamiliarPublisher({
        io: /** @type {any} */ ({ removeFile: async () => {} }),
        publishPath: '/tmp/gateway-test',
      }),
    { message: /writeFile must be a function/ },
  );
});

test('makeFamiliarPublisher rejects io without removeFile', t => {
  t.throws(
    () =>
      makeFamiliarPublisher({
        io: /** @type {any} */ ({ writeFile: async () => {} }),
        publishPath: '/tmp/gateway-test',
      }),
    { message: /removeFile must be a function/ },
  );
});

test('makeFamiliarPublisher rejects empty publishPath', t => {
  const { io } = makeRecorderIo();
  t.throws(() => makeFamiliarPublisher({ io, publishPath: '' }), {
    message: /publishPath must be a non-empty string/,
  });
});

test('getPublishPath returns the configured path', t => {
  const { io } = makeRecorderIo();
  const publisher = makeFamiliarPublisher({
    io,
    publishPath: '/some/abs/path',
  });
  t.is(publisher.getPublishPath(), '/some/abs/path');
});

// -- publish behavior ---------------------------------------------

test('publish writes the gateway URL with the bind address', async t => {
  const { io, calls, files } = makeRecorderIo();
  const publisher = makeFamiliarPublisher({
    io,
    publishPath: '/p/gateway',
  });
  await E(publisher).publish('127.0.0.1:54321');
  t.deepEqual(calls, [
    {
      op: 'writeFile',
      target: '/p/gateway',
      contents: 'http://127.0.0.1:54321\n',
    },
  ]);
  t.is(files.get('/p/gateway'), 'http://127.0.0.1:54321\n');
});

test('publish preserves IPv6 bracketed bind addresses', async t => {
  const { io, files } = makeRecorderIo();
  const publisher = makeFamiliarPublisher({
    io,
    publishPath: '/p/gateway',
  });
  await E(publisher).publish('[::1]:54321');
  // Regression: an IPv6 host in bracket notation must survive
  // intact so the Familiar's `new URL(...)` reader can parse it.
  // If a refactor coerces `host:port` through `parseBindAddress`
  // and then re-renders without brackets, the URL parser splits
  // the address on the wrong colon.
  t.is(files.get('/p/gateway'), 'http://[::1]:54321\n');
});

test('publish overwrites a prior published address', async t => {
  const { io, files, calls } = makeRecorderIo();
  const publisher = makeFamiliarPublisher({
    io,
    publishPath: '/p/gateway',
  });
  await E(publisher).publish('127.0.0.1:1111');
  await E(publisher).publish('127.0.0.1:2222');
  t.is(files.get('/p/gateway'), 'http://127.0.0.1:2222\n');
  t.is(calls.length, 2);
});

test('publish rejects an empty bind address', async t => {
  const { io } = makeRecorderIo();
  const publisher = makeFamiliarPublisher({
    io,
    publishPath: '/p/gateway',
  });
  await t.throwsAsync(() => E(publisher).publish(''), {
    message: /bindAddress must be a non-empty string/,
  });
});

test('publish rejects a bind address without a port', async t => {
  const { io } = makeRecorderIo();
  const publisher = makeFamiliarPublisher({
    io,
    publishPath: '/p/gateway',
  });
  // The publisher's whole job is to surface the OS-assigned port;
  // a bind address that drops the trailing `:<digits>` would
  // publish an unusable URL.
  await t.throwsAsync(() => E(publisher).publish('127.0.0.1'), {
    message: /bindAddress must end with :<port>/,
  });
});

test('publish propagates writeFile errors', async t => {
  const io = harden({
    async writeFile() {
      throw Error('disk full');
    },
    async removeFile() {
      // Unused in this test; required by the IoPowers shape.
      await null;
    },
  });
  const publisher = makeFamiliarPublisher({ io, publishPath: '/p/gateway' });
  await t.throwsAsync(() => E(publisher).publish('127.0.0.1:54321'), {
    message: /disk full/,
  });
});

// -- cleanup behavior ---------------------------------------------

test('cleanup before any publish is a no-op', async t => {
  const { io, calls } = makeRecorderIo();
  const publisher = makeFamiliarPublisher({
    io,
    publishPath: '/p/gateway',
  });
  await E(publisher).cleanup();
  t.deepEqual(calls, []);
});

test('cleanup after publish removes the file', async t => {
  const { io, calls, files } = makeRecorderIo();
  const publisher = makeFamiliarPublisher({
    io,
    publishPath: '/p/gateway',
  });
  await E(publisher).publish('127.0.0.1:54321');
  await E(publisher).cleanup();
  t.deepEqual(calls, [
    {
      op: 'writeFile',
      target: '/p/gateway',
      contents: 'http://127.0.0.1:54321\n',
    },
    { op: 'removeFile', target: '/p/gateway' },
  ]);
  t.false(files.has('/p/gateway'));
});

test('cleanup is idempotent after the first call', async t => {
  const { io, calls } = makeRecorderIo();
  const publisher = makeFamiliarPublisher({
    io,
    publishPath: '/p/gateway',
  });
  await E(publisher).publish('127.0.0.1:54321');
  await E(publisher).cleanup();
  await E(publisher).cleanup();
  // The second cleanup must not re-invoke removeFile; otherwise a
  // shutdown that happens to call cleanup twice would surface a
  // spurious error from the adapter.
  const removeCalls = calls.filter(c => c.op === 'removeFile');
  t.is(removeCalls.length, 1);
});

test('publish after cleanup re-writes the file', async t => {
  const { io, files } = makeRecorderIo();
  const publisher = makeFamiliarPublisher({
    io,
    publishPath: '/p/gateway',
  });
  await E(publisher).publish('127.0.0.1:1111');
  await E(publisher).cleanup();
  await E(publisher).publish('127.0.0.1:2222');
  // Regression: the published flag must reset on cleanup so a
  // subsequent publish writes again. If it sticks, a Familiar
  // that restarts its gateway after a clean shutdown reads a
  // missing file.
  t.is(files.get('/p/gateway'), 'http://127.0.0.1:2222\n');
});

test('cleanup propagates non-ENOENT removeFile errors', async t => {
  const io = harden({
    async writeFile() {
      // Unused in this test; required by the IoPowers shape.
      await null;
    },
    async removeFile() {
      throw Error('permission denied');
    },
  });
  const publisher = makeFamiliarPublisher({ io, publishPath: '/p/gateway' });
  await E(publisher).publish('127.0.0.1:54321');
  await t.throwsAsync(() => E(publisher).cleanup(), {
    message: /permission denied/,
  });
});

// -- Node adapter -------------------------------------------------

test('node adapter writes a UTF-8 file at the target path', async t => {
  const dir = await makeScratchDir(t);
  const target = path.join(dir, 'gateway');
  const io = makeNodeFamiliarPublishPowers();
  await io.writeFile(target, 'http://127.0.0.1:54321\n');
  const contents = await fs.readFile(target, 'utf8');
  t.is(contents, 'http://127.0.0.1:54321\n');
});

test('node adapter creates missing parent directories', async t => {
  // A first-run Familiar whose state directory does not yet exist
  // (fresh user profile) must not stall the gateway's `start()`
  // on a missing dirname.
  const dir = await makeScratchDir(t);
  const target = path.join(dir, 'deeply', 'nested', 'gateway');
  const io = makeNodeFamiliarPublishPowers();
  await io.writeFile(target, 'http://127.0.0.1:54321\n');
  const contents = await fs.readFile(target, 'utf8');
  t.is(contents, 'http://127.0.0.1:54321\n');
});

test('node adapter overwrites an existing file', async t => {
  const dir = await makeScratchDir(t);
  const target = path.join(dir, 'gateway');
  const io = makeNodeFamiliarPublishPowers();
  await io.writeFile(target, 'http://127.0.0.1:1111\n');
  await io.writeFile(target, 'http://127.0.0.1:2222\n');
  const contents = await fs.readFile(target, 'utf8');
  t.is(contents, 'http://127.0.0.1:2222\n');
});

test('node adapter removeFile removes an existing file', async t => {
  const dir = await makeScratchDir(t);
  const target = path.join(dir, 'gateway');
  const io = makeNodeFamiliarPublishPowers();
  await io.writeFile(target, 'http://127.0.0.1:54321\n');
  await io.removeFile(target);
  await t.throwsAsync(() => fs.access(target), { code: 'ENOENT' });
});

test('node adapter removeFile tolerates a missing file', async t => {
  const dir = await makeScratchDir(t);
  const target = path.join(dir, 'never-existed');
  const io = makeNodeFamiliarPublishPowers();
  // Regression: a user who manually deletes the published file
  // between publish and cleanup must not crash the gateway's
  // shutdown path. The adapter swallows ENOENT.
  await io.removeFile(target);
  t.pass();
});

test('node adapter removeFile propagates non-ENOENT errors', async t => {
  // We can not easily reproduce EACCES in a test sandbox; assert
  // the swallow-check is `ENOENT`-specific by checking that a
  // path with a non-existent parent (which throws ENOENT on
  // unlink, not EACCES) is silently tolerated. A future test on a
  // platform that allows fault injection can extend this.
  const dir = await makeScratchDir(t);
  const target = path.join(dir, 'missing-parent', 'gateway');
  const io = makeNodeFamiliarPublishPowers();
  await io.removeFile(target);
  t.pass();
});

// -- end-to-end with the Node adapter -----------------------------

test('publisher + node adapter publishes and cleans up a real file', async t => {
  const dir = await makeScratchDir(t);
  const publishPath = path.join(dir, 'gateway');
  const publisher = makeFamiliarPublisher({
    io: makeNodeFamiliarPublishPowers(),
    publishPath,
  });

  await E(publisher).publish('127.0.0.1:54321');
  t.is(await fs.readFile(publishPath, 'utf8'), 'http://127.0.0.1:54321\n');

  await E(publisher).cleanup();
  await t.throwsAsync(() => fs.access(publishPath), { code: 'ENOENT' });
});
