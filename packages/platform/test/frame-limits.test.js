// @ts-nocheck
// Per-frame `byteLengthLimit` bounds on the extended-filesystem writer sinks
// (`OpenFile.write`, `File.write`, `Xattrs.set`), the aggregate bound on an
// `Xattrs.set` value, and the invariant that a
// rejected frame leaves durable state unchanged.
//
// Each sink buffers frames and commits them in `return()`. The writer pump
// aborts a stream with `throw()`, and each sink discards its buffer there, so
// an oversized (or non-bytes) frame must not land a truncated write.

import '@endo/init/debug.js';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';

import { wrapBackend } from '../src/fs/extended/wrap-backend.js';
import { makeInMemoryBackend } from '../src/fs/extended/backends/in-memory-backend.js';

// Pinned here on purpose: a change to either literal in the source must fail
// a test.
const WRITE_FRAME_BYTE_LENGTH_LIMIT = 16 * 1024 * 1024;
const XATTR_FRAME_BYTE_LENGTH_LIMIT = 64 * 1024;

const utf8 = s => new TextEncoder().encode(s);
const fromUtf8 = b => new TextDecoder().decode(b);

const drainReader = async readerRef => {
  const chunks = [];
  let total = 0;
  for await (const c of iterateBytesReader(readerRef, {
    byteLengthLimit: WRITE_FRAME_BYTE_LENGTH_LIMIT,
  })) {
    chunks.push(c);
    total += c.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
};

/**
 * Push each frame in order, then close. Resolves once `return()` has
 * committed; rejects with the first frame the responder refuses.
 *
 * @param {any} writerRef
 * @param {Uint8Array[]} frames
 */
const pushFrames = async (writerRef, frames) => {
  const writer = iterateBytesWriter(writerRef);
  for (const frame of frames) {
    // eslint-disable-next-line no-await-in-loop
    await writer.next(frame);
  }
  await writer.return();
};

const makeFile = async (name, content) => {
  const fs = wrapBackend(makeInMemoryBackend());
  const root = await E(fs).root();
  const oh = await E(root).create(name, { write: true });
  await pushFrames(await E(oh).write(0n), [utf8(content)]);
  await E(oh).close();
  return root;
};

const readFile = async (root, name) => {
  const file = await E(root).lookup(name);
  return drainReader(await E(file).read());
};

// ---------- File.write ----------

test('File.write admits a frame of exactly the write frame limit', async t => {
  const root = await makeFile('f.bin', 'original');
  const file = await E(root).lookup('f.bin');
  const frame = new Uint8Array(WRITE_FRAME_BYTE_LENGTH_LIMIT).fill(7);
  await pushFrames(await E(file).write(), [frame]);
  const stat = await E(file).getStat();
  t.is(stat.size, BigInt(WRITE_FRAME_BYTE_LENGTH_LIMIT));
});

test('File.write rejects a frame one byte over the limit and leaves the file unchanged', async t => {
  const root = await makeFile('f.bin', 'original');
  const file = await E(root).lookup('f.bin');
  const writerRef = await E(file).write();
  await t.throwsAsync(() =>
    pushFrames(writerRef, [
      utf8('first '),
      utf8('second '),
      new Uint8Array(WRITE_FRAME_BYTE_LENGTH_LIMIT + 1),
    ]),
  );
  // Neither the accepted prefix nor a truncation reached the file.
  t.is(fromUtf8(await readFile(root, 'f.bin')), 'original');
});

// ---------- OpenFile.write ----------

test('OpenFile.write rejects a frame one byte over the limit and leaves the file unchanged', async t => {
  const root = await makeFile('o.bin', 'original');
  const oh = await E(await E(root).lookup('o.bin')).open({ write: true });
  const writerRef = await E(oh).write(0n);
  await t.throwsAsync(() =>
    pushFrames(writerRef, [
      utf8('PREFIX'),
      new Uint8Array(WRITE_FRAME_BYTE_LENGTH_LIMIT + 1),
    ]),
  );
  await E(oh).close();
  t.is(fromUtf8(await readFile(root, 'o.bin')), 'original');
});

// ---------- Xattrs.set ----------

const setXattr = async (xattrs, name, frames) =>
  pushFrames(await E(xattrs).set(name, {}), frames);

const getXattr = async (xattrs, name) => drainReader(await E(xattrs).get(name));

test('Xattrs.set admits a frame of exactly XATTR_SIZE_MAX bytes', async t => {
  const root = await makeFile('x.txt', 'data');
  const xattrs = await E(await E(root).lookup('x.txt')).xattrs();
  const frame = new Uint8Array(XATTR_FRAME_BYTE_LENGTH_LIMIT).fill(3);
  await setXattr(xattrs, 'user.big', [frame]);
  const got = await getXattr(xattrs, 'user.big');
  t.is(got.length, XATTR_FRAME_BYTE_LENGTH_LIMIT);
  t.is(got[got.length - 1], 3);
});

test('Xattrs.set rejects a frame one byte over the limit and keeps the old value', async t => {
  const root = await makeFile('x.txt', 'data');
  const xattrs = await E(await E(root).lookup('x.txt')).xattrs();
  await setXattr(xattrs, 'user.x', [utf8('old')]);
  await t.throwsAsync(() =>
    setXattr(xattrs, 'user.x', [
      new Uint8Array(XATTR_FRAME_BYTE_LENGTH_LIMIT + 1),
    ]),
  );
  t.is(fromUtf8(await getXattr(xattrs, 'user.x')), 'old');
});

test('Xattrs.set rejected on a fresh name leaves the name unset', async t => {
  const root = await makeFile('x.txt', 'data');
  const xattrs = await E(await E(root).lookup('x.txt')).xattrs();
  await t.throwsAsync(() =>
    setXattr(xattrs, 'user.fresh', [
      utf8('ok'),
      new Uint8Array(XATTR_FRAME_BYTE_LENGTH_LIMIT + 1),
    ]),
  );
  await t.throwsAsync(() => E(xattrs).get('user.fresh'), {
    message: /ENODATA/,
  });
});

test('Xattrs.set rejects in-limit frames whose total exceeds the limit', async t => {
  const root = await makeFile('x.txt', 'data');
  const xattrs = await E(await E(root).lookup('x.txt')).xattrs();
  await setXattr(xattrs, 'user.x', [utf8('old')]);
  const half = XATTR_FRAME_BYTE_LENGTH_LIMIT / 2;
  await t.throwsAsync(
    () =>
      setXattr(xattrs, 'user.x', [
        new Uint8Array(half),
        new Uint8Array(half),
        new Uint8Array(1),
      ]),
    { message: /E2BIG/ },
  );
  t.is(fromUtf8(await getXattr(xattrs, 'user.x')), 'old');
});

test('Xattrs.set admits in-limit frames totaling exactly the limit', async t => {
  const root = await makeFile('x.txt', 'data');
  const xattrs = await E(await E(root).lookup('x.txt')).xattrs();
  const half = XATTR_FRAME_BYTE_LENGTH_LIMIT / 2;
  await setXattr(xattrs, 'user.x', [
    new Uint8Array(half).fill(1),
    new Uint8Array(half).fill(2),
  ]);
  const got = await getXattr(xattrs, 'user.x');
  t.is(got.length, XATTR_FRAME_BYTE_LENGTH_LIMIT);
  t.is(got[0], 1);
  t.is(got[got.length - 1], 2);
});

// A non-bytes frame (for example a stale base64 string from a pre-upgrade
// initiator) is rejected by the kind check and must not commit either.
test('File.write rejects a non-bytes frame and leaves the file unchanged', async t => {
  const root = await makeFile('s.bin', 'original');
  const file = await E(root).lookup('s.bin');
  const writerRef = await E(file).write();
  const terminal = harden({ value: undefined, promise: null });
  const synHead = harden({
    value: 'c3RhbGU=',
    promise: Promise.resolve(terminal),
  });
  await t.throwsAsync(() =>
    E(writerRef).stream(/** @type {any} */ (Promise.resolve(synHead))),
  );
  t.is(fromUtf8(await readFile(root, 's.bin')), 'original');
});
