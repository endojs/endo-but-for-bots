// @ts-check

import '@endo/init/debug.js';

import test from 'ava';
import { Buffer } from 'node:buffer';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { E } from '@endo/eventual-send';
import { bytesWriterFromIterator } from '@endo/exo-stream/bytes-writer-from-iterator.js';
import { Far } from '@endo/pass-style';

import { makeFsMounterKit } from '../mount-caplet.js';
import { makeFsBridge9p } from '../src/fs-bridge.js';
import { makeWriter, tryParseMessage, wrapMessage } from '../src/wire.js';
import { T } from '../src/types.js';

/** @import { ExecutionContext } from 'ava' */

const deferred = () => {
  let resolve = () => {};
  const promise = new Promise(res => {
    resolve = () => res(undefined);
  });
  return harden({ promise, resolve });
};

/** @param {ExecutionContext} t */
const makeLocation = async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), '9p-bridge-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'bridge.sock');
};

/**
 * @param {{write?: () => Promise<void>, close?: (id: number) => Promise<void>}} [effects]
 */
const makeFilesystem = ({
  write = async () => {},
  close = async () => {},
} = {}) => {
  let opens = 0;
  const file = Far('File', {
    getQid: () => harden({ type: 'file', version: 0n, pathId: 2n }),
    open: () => {
      opens += 1;
      const id = opens;
      return Far('OpenFile', {
        write: () =>
          bytesWriterFromIterator(
            harden({
              next: async () => {
                await write();
                return harden({ done: false, value: undefined });
              },
              return: async () => harden({ done: true, value: undefined }),
            }),
          ),
        close: () => close(id),
      });
    },
  });
  const root = Far('Directory', {
    getQid: () => harden({ type: 'directory', version: 0n, pathId: 1n }),
    lookup: () => file,
  });
  return Far('Filesystem', { root: () => root });
};

/**
 * A sequential wire client for the lifecycle tests. Buffer is required by the
 * current 9P parser; filesystem payloads remain Uint8Array values.
 * @param {ExecutionContext} t
 * @param {string} socketPath
 */
const connect = async (t, socketPath) => {
  const socket = net.createConnection(socketPath);
  const closed = deferred();
  socket.once('close', closed.resolve);
  t.teardown(async () => {
    socket.destroy();
    await closed.promise;
  });
  /** @type {Buffer} */
  let buffer = Buffer.alloc(0);
  /** @type {{resolve: (type: number) => void, reject: (reason: Error) => void} | undefined} */
  let reply;
  socket.on('data', chunk => {
    // This client never sets a string encoding on its socket.
    const bytes = /** @type {Buffer} */ (chunk);
    buffer = Buffer.concat([buffer, bytes]);
    const parsed = tryParseMessage(buffer);
    if (parsed) {
      buffer = parsed.rest;
      reply?.resolve(parsed.msg.type);
      reply = undefined;
    }
  });
  socket.on('error', reason => reply?.reject(reason));
  socket.on('close', () => reply?.reject(Error('Client socket closed')));
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  /**
   * @param {number} type
   * @param {(writer: ReturnType<typeof makeWriter>) => void} fill
   */
  const request = (type, fill) => {
    const result = new Promise((resolve, reject) => {
      reply = { resolve, reject };
    });
    const writer = makeWriter();
    fill(writer);
    socket.write(wrapMessage(type, 1, writer.finish()));
    return result;
  };
  t.is(
    await request(T.Tversion, w => {
      w.u32(8192);
      w.str('9P2000.L');
    }),
    T.Rversion,
  );
  t.is(
    await request(T.Tattach, w => {
      w.u32(1);
      w.u32(0xffff_ffff);
      w.str('');
      w.str('');
      w.u32(0);
    }),
    T.Rattach,
  );
  t.is(
    await request(T.Twalk, w => {
      w.u32(1);
      w.u32(2);
      w.u16(1);
      w.str('file');
    }),
    T.Rwalk,
  );
  t.is(
    await request(T.Tlopen, w => {
      w.u32(2);
      w.u32(2);
    }),
    T.Rlopen,
  );
  return {
    closed: closed.promise,
    write: () =>
      request(T.Twrite, w => {
        w.u32(2);
        w.u64(0n);
        w.u32(1);
        w.bytes(new Uint8Array([1]));
      }),
  };
};

test.serial(
  'stop before start fences acquisition without touching the socket path',
  async t => {
    t.timeout(5000);
    const socketPath = await makeLocation(t);
    await writeFile(socketPath, 'existing');
    const bridge = makeFsBridge9p({ fs: makeFilesystem(), socketPath });
    await E(bridge).stop();
    await t.throwsAsync(E(bridge).start(), { message: /stopped/ });
    t.is(await readFile(socketPath, 'utf8'), 'existing');
  },
);

test.serial(
  'stop drains a pending start and forbids a late listener',
  async t => {
    t.timeout(5000);
    const socketPath = await makeLocation(t);
    const bridge = makeFsBridge9p({ fs: makeFilesystem(), socketPath });
    t.teardown(() => E(bridge).stop());
    const starting = E(bridge).start();
    const refused = t.throwsAsync(starting, { message: /stopped/ });
    await E(bridge).stop();
    await refused;
    await t.throwsAsync(stat(socketPath), { code: 'ENOENT' });
    await t.throwsAsync(E(bridge).start(), { message: /stopped/ });
  },
);

test.serial(
  'concurrent start coalesces and successful stop cannot unlink a successor',
  async t => {
    t.timeout(5000);
    const socketPath = await makeLocation(t);
    const bridge = makeFsBridge9p({ fs: makeFilesystem(), socketPath });
    t.teardown(() => E(bridge).stop());
    await Promise.all([E(bridge).start(), E(bridge).start()]);
    t.true((await stat(socketPath)).isSocket());
    await Promise.all([E(bridge).stop(), E(bridge).stop()]);
    await writeFile(socketPath, 'successor');
    await E(bridge).stop();
    t.is(await readFile(socketPath, 'utf8'), 'successor');
  },
);

test.serial('failed socket unlink remains owned and retryable', async t => {
  t.timeout(5000);
  const socketPath = await makeLocation(t);
  const bridge = makeFsBridge9p({ fs: makeFilesystem(), socketPath });
  t.teardown(async () => {
    await rm(socketPath, { recursive: true, force: true });
    await E(bridge).stop();
  });
  await E(bridge).start();
  await unlink(socketPath);
  await mkdir(socketPath);
  await t.throwsAsync(E(bridge).stop(), { message: /EISDIR|EPERM/ });
  await rm(socketPath, { recursive: true });
  await E(bridge).stop();
  await t.throwsAsync(stat(socketPath), { code: 'ENOENT' });
});

test.serial(
  'stop waits for admitted writes and handle closure after native socket close',
  async t => {
    t.timeout(5000);
    const writeEntered = deferred();
    const writeResume = deferred();
    const closeEntered = deferred();
    const closeResume = deferred();
    t.teardown(() => {
      writeResume.resolve();
      closeResume.resolve();
    });
    const fs = makeFilesystem({
      write: async () => {
        writeEntered.resolve();
        await writeResume.promise;
      },
      close: async () => {
        closeEntered.resolve();
        await closeResume.promise;
      },
    });
    const socketPath = await makeLocation(t);
    const bridge = makeFsBridge9p({ fs, socketPath });
    t.teardown(async () => {
      writeResume.resolve();
      closeResume.resolve();
      await E(bridge).stop();
    });
    await E(bridge).start();
    const client = await connect(t, socketPath);
    const write = client.write().catch(() => {});
    await writeEntered.promise;
    let stopped = false;
    const stopping = E(bridge)
      .stop()
      .then(() => {
        stopped = true;
      });
    await client.closed;
    t.false(stopped);
    writeResume.resolve();
    await closeEntered.promise;
    t.false(stopped);
    closeResume.resolve();
    await stopping;
    await write;
    t.true(stopped);
  },
);

test.serial(
  'failed connection cleanup is retained after socket close and only failed owners retry',
  async t => {
    t.timeout(5000);
    let fail = true;
    /** @type {number[]} */
    const attempts = [];
    const fs = makeFilesystem({
      close: async id => {
        attempts.push(id);
        if (fail && id === 1) throw Error('Held close failure');
      },
    });
    const socketPath = await makeLocation(t);
    const bridge = makeFsBridge9p({ fs, socketPath });
    t.teardown(async () => {
      fail = false;
      await E(bridge).stop();
    });
    await E(bridge).start();
    const first = await connect(t, socketPath);
    const second = await connect(t, socketPath);
    await t.throwsAsync(E(bridge).stop(), { message: /bridge cleanup failed/ });
    await Promise.all([first.closed, second.closed]);
    t.deepEqual(attempts, [1, 2]);
    fail = false;
    await E(bridge).stop();
    t.deepEqual(attempts, [1, 2, 1]);
  },
);

test.serial(
  'failed native listen remains stoppable and cannot restart',
  async t => {
    t.timeout(5000);
    const location = await makeLocation(t);
    const socketPath = path.join(path.dirname(location), 'missing', 'x');
    const bridge = makeFsBridge9p({ fs: makeFilesystem(), socketPath });
    t.teardown(() => E(bridge).stop());
    const error = await t.throwsAsync(E(bridge).start(), { message: /listen/ });
    t.like(error, { syscall: 'listen', address: socketPath });
    await E(bridge).stop();
    await t.throwsAsync(E(bridge).start(), { message: /stopped/ });
  },
);

test.serial(
  'cancellation fences the listener while retained cleanup drains',
  async t => {
    t.timeout(5000);
    const cancelled = deferred();
    const closeEntered = deferred();
    const closeResume = deferred();
    const socketPath = await makeLocation(t);
    const fs = makeFilesystem({
      close: async () => {
        closeEntered.resolve();
        await closeResume.promise;
      },
    });
    const bridge = makeFsBridge9p({
      fs,
      socketPath,
      cancelled: cancelled.promise,
    });
    t.teardown(async () => {
      cancelled.resolve();
      closeResume.resolve();
      await E(bridge).stop();
    });
    await E(bridge).start();
    const client = await connect(t, socketPath);
    cancelled.resolve();
    await client.closed;
    await closeEntered.promise;
    await t.throwsAsync(E(bridge).start(), { message: /stopped/ });
    let complete = false;
    const stopped = E(bridge)
      .stop()
      .then(() => {
        complete = true;
      });
    await new Promise(resolve => setImmediate(resolve));
    t.false(complete);
    closeResume.resolve();
    await stopped;
  },
);

test.serial(
  'mounter close retains storage through real bridge drain and failed handle release',
  async t => {
    t.timeout(5000);
    const socketPath = await makeLocation(t);
    const mountPoint = path.join(path.dirname(socketPath), 'mount');
    const writeEntered = deferred();
    const writeResume = deferred();
    let failClose = true;
    const fs = makeFilesystem({
      write: async () => {
        writeEntered.resolve();
        await writeResume.promise;
      },
      close: async () => {
        if (failClose) throw Error('handle still owned');
      },
    });
    const commands = /** @type {string[]} */ ([]);
    const removals = /** @type {string[]} */ ([]);
    const kit = makeFsMounterKit({
      env: { NINEP_SOCKET_DIR: path.dirname(socketPath) },
      // The native listener and protocol are real; kernel mount commands are
      // simulated here. Linux acceptance remains a separate required test.
      runProgram: async bin => {
        commands.push(bin);
      },
      makeDir: mkdir,
      removeDir: async directory => {
        removals.push(directory);
        await rmdir(directory);
      },
      makeBridge: makeFsBridge9p,
    });
    t.teardown(async () => {
      failClose = false;
      writeResume.resolve();
      await kit.close();
    });
    await E(kit.mounter).mount(
      fs,
      mountPoint,
      harden({ socketPath, removeMountPointOnUnmount: true }),
    );
    const client = await connect(t, socketPath);
    const write = t.throwsAsync(client.write(), { message: /socket closed/i });
    await writeEntered.promise;
    let settled = false;
    const closed = t
      .throwsAsync(kit.close(), { message: /shutdown pending/ })
      .then(() => {
        settled = true;
      });
    await client.closed;
    await write;
    t.deepEqual(commands, ['mount', 'umount']);
    t.false(settled);
    t.deepEqual(removals, []);
    writeResume.resolve();
    await closed;
    t.true((await stat(mountPoint)).isDirectory());
    t.deepEqual(removals, []);
    failClose = false;
    await kit.close();
    t.deepEqual(commands, ['mount', 'umount']);
    t.deepEqual(removals, [mountPoint]);
    await t.throwsAsync(stat(mountPoint), { code: 'ENOENT' });
  },
);
