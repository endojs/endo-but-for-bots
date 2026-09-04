// @ts-nocheck

/**
 * Regression coverage for the windowed-read EOF loop shared by the daemon and
 * content-store range-read powers (`readWindowToEnd` /
 * `readFileHandleWindow`).
 *
 * The seam under test is the reason a windowed read must NOT derive its length
 * from `stat().size` or stop on the first short read: a procfs/sysfs/FIFO
 * source reports a stale-or-zero size and short-reads mid-window, and
 * truncating there would mint a false empty content address (the SHA-256 of the
 * empty string) for a source that has content. These tests inject a fake source
 * whose reads return short — the exact shape the old single-`handle.read` path
 * mishandled.
 */

import '@endo/init/debug.js';

import test from 'ava';
import { decodeUtf8 } from '@endo/utf8/decode.js';
import { encodeUtf8 } from '@endo/utf8/encode.js';

import {
  readWindowToEnd,
  readFileHandleWindow,
  READ_WINDOW_CHUNK_BYTES,
} from '../src/fs-node/read-file-window.js';

const utf8 = encodeUtf8;
const fromUtf8 = decodeUtf8;

/**
 * A fake `read` seam over `data` that never returns more than `maxPerRead`
 * bytes per call — the short-read behaviour of a virtual source. A zero-length
 * read (position at/after EOF) is the only EOF signal.
 *
 * @param {Uint8Array} data
 * @param {number} maxPerRead
 */
const makeShortReader = (data, maxPerRead) => {
  let calls = 0;
  /**
   * @param {Uint8Array} buffer
   * @param {number} position
   * @param {number} wanted
   */
  const read = async (buffer, position, wanted) => {
    calls += 1;
    if (position >= data.length) {
      return 0;
    }
    const n = Math.min(maxPerRead, wanted, data.length - position);
    buffer.set(data.subarray(position, position + n), 0);
    return n;
  };
  return { read, callCount: () => calls };
};

test('readWindowToEnd loops past short reads instead of truncating', async t => {
  const data = utf8('hello, world');
  const { read, callCount } = makeShortReader(data, 3);
  // `length` is the end-of-content sentinel a caller passes when it does not
  // know (or cannot trust) the source size — exactly where `stat().size`
  // clamping would fail. The chunk size is small so many short reads are
  // required to reach EOF.
  const bytes = await readWindowToEnd(read, 0, Number.MAX_SAFE_INTEGER, 4);
  t.is(fromUtf8(bytes), 'hello, world');
  t.true(callCount() > 1, 'more than one read was needed to reach EOF');
});

test('readWindowToEnd reads content a zero stat().size would have hidden', async t => {
  // A procfs-style source: it has content but a huge requested length and a
  // source that only yields 1 byte per read. The old `stat().size`-clamp path
  // would have returned an empty array (a false content address); the loop
  // returns every byte.
  const data = utf8('proc-content');
  const { read } = makeShortReader(data, 1);
  const bytes = await readWindowToEnd(read, 0, Number.MAX_SAFE_INTEGER);
  t.not(bytes.length, 0, 'a source with content never reads back empty');
  t.is(fromUtf8(bytes), 'proc-content');
});

test('readWindowToEnd honors an explicit shorter length', async t => {
  const data = utf8('hello, world');
  const { read } = makeShortReader(data, 2);
  const bytes = await readWindowToEnd(read, 0, 5, 4);
  t.is(fromUtf8(bytes), 'hello');
});

test('readWindowToEnd honors a non-zero offset', async t => {
  const data = utf8('hello, world');
  const { read } = makeShortReader(data, 3);
  const bytes = await readWindowToEnd(read, 7, Number.MAX_SAFE_INTEGER, 4);
  t.is(fromUtf8(bytes), 'world');
});

test('readWindowToEnd returns empty for a non-positive length without reading', async t => {
  const data = utf8('hello');
  const { read, callCount } = makeShortReader(data, 3);
  const bytes = await readWindowToEnd(read, 0, 0);
  t.is(bytes.length, 0);
  t.is(callCount(), 0);
});

test('readFileHandleWindow drives handle.read to EOF over short reads', async t => {
  const data = utf8('hello, world');
  let calls = 0;
  // A fake FileHandle whose `read` fills at most 3 bytes per call and reports
  // EOF only via a zero-length read — the exact shape a real short-reading
  // source presents.
  const handle = {
    /**
     * @param {Uint8Array} buffer
     * @param {number} offset
     * @param {number} wanted
     * @param {number} position
     */
    async read(buffer, offset, wanted, position) {
      calls += 1;
      if (position >= data.length) {
        return { bytesRead: 0 };
      }
      const n = Math.min(3, wanted, data.length - position);
      buffer.set(data.subarray(position, position + n), offset);
      return { bytesRead: n };
    },
  };
  const bytes = await readFileHandleWindow(
    handle,
    0,
    Number.MAX_SAFE_INTEGER,
    4,
  );
  t.is(fromUtf8(bytes), 'hello, world');
  t.true(calls > 1);
});

test('READ_WINDOW_CHUNK_BYTES is a positive bound', t => {
  t.true(Number.isSafeInteger(READ_WINDOW_CHUNK_BYTES));
  t.true(READ_WINDOW_CHUNK_BYTES > 0);
});
