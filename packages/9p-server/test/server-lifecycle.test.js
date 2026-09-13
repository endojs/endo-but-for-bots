// @ts-check

import '@endo/init/debug.js';

import test from 'ava';
import { EventEmitter } from 'node:events';
import { Far } from '@endo/pass-style';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { bytesWriterFromIterator } from '@endo/exo-stream/bytes-writer-from-iterator.js';

import { serveConnection } from '../src/server.js';
import { makeWriter, tryParseMessage, wrapMessage } from '../src/wire.js';
import { T } from '../src/types.js';

/** @import { ExecutionContext } from 'ava' */

const defer = () => {
  /** @type {(value?: any) => void} */
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return {
    promise,
    resolve: (/** @type {any} */ value = undefined) => resolve(value),
  };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const dirQid = harden({ type: 'directory', pathId: 0n, version: 0n });
const fileQid = harden({ type: 'file', pathId: 1n, version: 0n });

/**
 * @param {ExecutionContext} t
 * @param {any} fs
 * @param {() => void} [onClose]
 */
const makePeer = (t, fs, onClose) => {
  const socket = new EventEmitter();
  /** @type {any[]} */
  const replies = [];
  /** @type {Array<(value: any) => void>} */
  const waiters = [];
  let destroyed = false;
  const transport = Object.assign(socket, {
    write: (/** @type {any} */ data) => {
      const message = tryParseMessage(data)?.msg;
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else replies.push(message);
    },
    destroy: () => {
      if (!destroyed) {
        destroyed = true;
        socket.emit('close');
      }
      return transport;
    },
  });
  const control = serveConnection({
    fs,
    // This local transport intentionally implements only the Socket methods
    // used by the server. No socket, listener, or kernel mount is opened.
    socket: /** @type {Parameters<typeof serveConnection>[0]['socket']} */ (
      /** @type {unknown} */ (transport)
    ),
    onClose,
  });
  t.teardown(() => control.close());
  /**
   * @param {number} type
   * @param {(w: ReturnType<typeof makeWriter>) => void} fill
   */
  const send = (type, fill) => {
    const w = makeWriter();
    fill(w);
    socket.emit('data', wrapMessage(type, 1, w.finish()));
  };
  /**
   * @param {number} type
   * @param {(w: ReturnType<typeof makeWriter>) => void} fill
   */
  const request = (type, fill) => {
    /** @type {Promise<any>} */
    const reply = new Promise(resolve => {
      if (replies.length) resolve(replies.shift());
      else waiters.push(resolve);
    });
    send(type, fill);
    return reply;
  };
  const init = async () => {
    await request(T.Tversion, w => {
      w.u32(8192);
      w.str('9P2000.L');
    });
    await request(T.Tattach, w => {
      w.u32(1);
      w.u32(0xffff_ffff);
      w.str('');
      w.str('');
      w.u32(0);
    });
  };
  /**
   * @param {number} fid
   * @param {number} [flags]
   */
  const open = (fid, flags = 0) =>
    request(T.Tlopen, w => {
      w.u32(fid);
      w.u32(flags);
    });
  const walkFile = () =>
    request(T.Twalk, w => {
      w.u32(1);
      w.u32(2);
      w.u16(1);
      w.str('file');
    });
  return { control, socket, request, send, init, open, walkFile, replies };
};

for (const trigger of ['control', 'disconnect']) {
  test(`connection ${trigger} waits for and closes a late OpenFile`, async t => {
    t.timeout(5000);
    const entered = defer();
    const opened = defer();
    t.teardown(() => opened.resolve(handle));
    let closes = 0;
    let lookups = 0;
    const handle = Far('OpenFile', {
      close: async () => {
        closes += 1;
      },
    });
    const file = Far('File', {
      getQid: () => fileQid,
      open: async () => {
        entered.resolve();
        return opened.promise;
      },
    });
    const root = Far('Directory', {
      getQid: () => dirQid,
      lookup: () => {
        lookups += 1;
        return file;
      },
    });
    const peer = makePeer(t, Far('Filesystem', { root: () => root }));
    await peer.init();
    await peer.walkFile();
    peer.send(T.Tlopen, w => {
      w.u32(2);
      w.u32(0);
    });
    await entered.promise;
    if (trigger === 'disconnect') peer.socket.emit('close');
    const closed = peer.control.close();
    t.is(peer.control.close(), closed);
    let finished = false;
    void closed.then(() => {
      finished = true;
    });
    peer.send(T.Twalk, w => {
      w.u32(1);
      w.u32(3);
      w.u16(1);
      w.str('file');
    });
    await tick();
    t.false(finished);
    t.is(closes, 0);
    opened.resolve(handle);
    await closed;
    t.is(closes, 1);
    t.is(lookups, 1);
    t.deepEqual(peer.replies, []);
  });
}

test('connection close waits for an admitted write before closing its OpenFile', async t => {
  t.timeout(5000);
  const entered = defer();
  const written = defer();
  t.teardown(() => written.resolve());
  let fileCloses = 0;
  let writerCloses = 0;
  const writer = bytesWriterFromIterator(
    harden({
      next: async () => {
        entered.resolve();
        await written.promise;
        return harden({ done: false, value: undefined });
      },
      return: async () => {
        writerCloses += 1;
        return harden({ done: /** @type {const} */ (true), value: undefined });
      },
    }),
  );
  const handle = Far('OpenFile', {
    write: async () => writer,
    close: async () => {
      fileCloses += 1;
    },
  });
  const file = Far('File', { getQid: () => fileQid, open: () => handle });
  const root = Far('Directory', { getQid: () => dirQid, lookup: () => file });
  const peer = makePeer(t, Far('Filesystem', { root: () => root }));
  await peer.init();
  await peer.walkFile();
  await peer.open(2, 2);
  peer.send(T.Twrite, w => {
    w.u32(2);
    w.u64(0n);
    w.u32(1);
    w.u8(42);
  });
  await entered.promise;
  const closed = peer.control.close();
  await tick();
  t.is(fileCloses, 0);
  written.resolve();
  await closed;
  t.is(writerCloses, 1);
  t.is(fileCloses, 1);
});

for (const late of [false, true]) {
  test(`connection close signals ${late ? 'late' : 'pending'} reader before draining dispatch`, async t => {
    t.timeout(5000);
    const entered = defer();
    const read = defer();
    const pulled = defer();
    const cancelled = defer();
    const returned = defer();
    const release = defer();
    t.teardown(() => {
      read.resolve(reader);
      cancelled.resolve();
      release.resolve();
    });
    let pulls = 0;
    let fileCloses = 0;
    const reader = bytesReaderFromIterator(
      harden({
        next: async () => {
          pulls += 1;
          pulled.resolve();
          await cancelled.promise;
          return harden({
            done: /** @type {const} */ (true),
            value: undefined,
          });
        },
        return: async () => {
          returned.resolve();
          await release.promise;
          return harden({
            done: /** @type {const} */ (true),
            value: undefined,
          });
        },
      }),
      { cancelPending: () => cancelled.resolve() },
    );
    const handle = Far('OpenFile', {
      read: () => {
        entered.resolve();
        return late ? read.promise : reader;
      },
      close: () => {
        fileCloses += 1;
      },
    });
    const file = Far('File', { getQid: () => fileQid, open: () => handle });
    const root = Far('Directory', { getQid: () => dirQid, lookup: () => file });
    const peer = makePeer(t, Far('Filesystem', { root: () => root }));
    await peer.init();
    await peer.walkFile();
    await peer.open(2);
    peer.send(T.Tread, w => {
      w.u32(2);
      w.u64(0n);
      w.u32(1);
    });
    await entered.promise;
    if (!late) await pulled.promise;
    const closing = peer.control.close();
    read.resolve(reader);
    await returned.promise;
    t.is(fileCloses, 0, 'file remains open until reader cleanup finishes');
    t.is(pulls, late ? 0 : 1);
    release.resolve();
    await closing;
    t.is(fileCloses, 1);
  });
}

test('connection close retains a failed cursor closure and retries only remaining resources', async t => {
  t.timeout(5000);
  let cursorCloses = 0;
  let fileCloses = 0;
  let notifications = 0;
  const cursor = Far('Cursor', {
    close: async () => {
      cursorCloses += 1;
      if (cursorCloses === 1) throw Error('Cursor close failed');
    },
  });
  const handle = Far('OpenFile', {
    close: async () => {
      fileCloses += 1;
    },
  });
  const file = Far('File', { getQid: () => fileQid, open: () => handle });
  const root = Far('Directory', {
    getQid: () => dirQid,
    lookup: () => file,
    list: () => cursor,
  });
  const peer = makePeer(t, Far('Filesystem', { root: () => root }), () => {
    notifications += 1;
  });
  await peer.init();
  await peer.walkFile();
  await peer.open(1);
  await peer.open(2);
  const failure = await t.throwsAsync(peer.control.close(), {
    instanceOf: AggregateError,
    message: /cleanup failed/,
  });
  t.is(failure?.errors[0].message, 'Cursor close failed');
  t.is(notifications, 0);
  t.is(fileCloses, 1);
  await peer.control.close();
  t.is(cursorCloses, 2);
  t.is(fileCloses, 1);
  t.is(notifications, 1);
});

test('connection close waits for a held cursor closure', async t => {
  t.timeout(5000);
  const entered = defer();
  const released = defer();
  t.teardown(() => released.resolve());
  const cursor = Far('Cursor', {
    close: async () => {
      entered.resolve();
      await released.promise;
    },
  });
  const root = Far('Directory', { getQid: () => dirQid, list: () => cursor });
  const peer = makePeer(t, Far('Filesystem', { root: () => root }));
  await peer.init();
  await peer.open(1);
  const closed = peer.control.close();
  let finished = false;
  void closed.then(() => {
    finished = true;
  });
  await entered.promise;
  await tick();
  t.false(finished);
  released.resolve();
  await closed;
});

test('socket-triggered cleanup failure stays owned until an explicit retry', async t => {
  t.timeout(5000);
  let attempts = 0;
  let notifications = 0;
  const cursor = Far('Cursor', {
    close: async () => {
      attempts += 1;
      if (attempts === 1) throw Error('Cursor cleanup failed');
    },
  });
  const root = Far('Directory', { getQid: () => dirQid, list: () => cursor });
  const peer = makePeer(t, Far('Filesystem', { root: () => root }), () => {
    notifications += 1;
  });
  await peer.init();
  await peer.open(1);
  peer.socket.emit('close');
  await tick();
  t.is(attempts, 1);
  t.is(notifications, 0);
  await peer.control.close();
  t.is(attempts, 2);
  t.is(notifications, 1);
});

test('a created OpenFile remains owned when the following lookup fails', async t => {
  let closes = 0;
  const handle = Far('OpenFile', {
    close: async () => {
      closes += 1;
    },
  });
  const root = Far('Directory', {
    getQid: () => dirQid,
    create: () => handle,
    lookup: () => {
      throw Error('ENOENT: failed lookup');
    },
  });
  const peer = makePeer(t, Far('Filesystem', { root: () => root }));
  await peer.init();
  const response = await peer.request(T.Tlcreate, w => {
    w.u32(1);
    w.str('file');
    w.u32(2);
    w.u32(0o600);
    w.u32(0);
  });
  t.is(response.type, T.Rlerror);
  await peer.control.close();
  t.is(closes, 1);
});

test('connection close drains issued walk calls after an early error reply', async t => {
  t.timeout(5000);
  const lookedUp = defer();
  const entered = defer();
  t.teardown(() => lookedUp.resolve(file));
  const file = Far('File', { getQid: () => fileQid });
  const broken = Far('BrokenDirectory', {
    getQid: () => {
      throw Error('EIO: qid failed');
    },
    lookup: async () => {
      entered.resolve();
      return lookedUp.promise;
    },
  });
  const root = Far('Directory', { getQid: () => dirQid, lookup: () => broken });
  const peer = makePeer(t, Far('Filesystem', { root: () => root }));
  await peer.init();
  const reply = await peer.request(T.Twalk, w => {
    w.u32(1);
    w.u32(2);
    w.u16(2);
    w.str('broken');
    w.str('late');
  });
  t.is(reply.type, T.Rlerror);
  await entered.promise;
  const closed = peer.control.close();
  let finished = false;
  void closed.then(() => {
    finished = true;
  });
  await tick();
  t.false(finished);
  lookedUp.resolve(file);
  await closed;
});

for (const failCleanup of [false, true]) {
  test(`connection cleanup separates read failure from ${failCleanup ? 'failed' : 'successful'} stream release`, async t => {
    t.timeout(5000);
    let refuseCleanup = failCleanup;
    t.teardown(() => {
      refuseCleanup = false;
    });
    let fileCloses = 0;
    let readerCloses = 0;
    const reader = bytesReaderFromIterator(
      harden({
        next: async () => {
          throw Error('read failed');
        },
        return: async () => {
          readerCloses += 1;
          if (refuseCleanup) throw Error('reader cleanup failed');
          return harden({
            done: /** @type {const} */ (true),
            value: undefined,
          });
        },
      }),
    );
    const handle = Far('OpenFile', {
      read: () => reader,
      close: () => {
        fileCloses += 1;
      },
    });
    const file = Far('File', { getQid: () => fileQid, open: () => handle });
    const root = Far('Directory', { getQid: () => dirQid, lookup: () => file });
    const peer = makePeer(t, Far('Filesystem', { root: () => root }));
    await peer.init();
    await peer.walkFile();
    await peer.open(2);
    const reply = await peer.request(T.Tread, w => {
      w.u32(2);
      w.u64(0n);
      w.u32(1);
    });
    t.is(reply.type, T.Rlerror);
    if (failCleanup) {
      await t.throwsAsync(peer.control.close(), { message: /cleanup failed/ });
      t.is(fileCloses, 0, 'failed stream cleanup retains its parent OpenFile');
      refuseCleanup = false;
    }
    await peer.control.close();
    t.is(fileCloses, 1);
    if (!failCleanup) t.is(readerCloses, 1);
  });
}

test('Tclunk retains its fid and parent while a prior stream cleanup is failing', async t => {
  t.timeout(5000);
  let refuseCleanup = true;
  t.teardown(() => {
    refuseCleanup = false;
  });
  let fileCloses = 0;
  const reader = bytesReaderFromIterator(
    harden({
      next: async () => {
        throw Error('read failed');
      },
      return: async () => {
        if (refuseCleanup) throw Error('reader cleanup failed');
        return harden({ done: /** @type {const} */ (true), value: undefined });
      },
    }),
  );
  const handle = Far('OpenFile', {
    read: () => reader,
    close: () => {
      fileCloses += 1;
    },
  });
  const file = Far('File', { getQid: () => fileQid, open: () => handle });
  const root = Far('Directory', { getQid: () => dirQid, lookup: () => file });
  const peer = makePeer(t, Far('Filesystem', { root: () => root }));
  await peer.init();
  await peer.walkFile();
  await peer.open(2);
  const readReply = await peer.request(T.Tread, w => {
    w.u32(2);
    w.u64(0n);
    w.u32(1);
  });
  t.is(readReply.type, T.Rlerror);
  const failedClunk = await peer.request(T.Tclunk, w => w.u32(2));
  t.is(failedClunk.type, T.Rlerror);
  t.is(fileCloses, 0);
  refuseCleanup = false;
  const clunked = await peer.request(T.Tclunk, w => w.u32(2));
  t.is(clunked.type, T.Rclunk);
  t.is(fileCloses, 1);
  await peer.control.close();
  t.is(fileCloses, 1);
});
