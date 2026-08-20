// @ts-nocheck
/* eslint-disable import/order, no-await-in-loop */

/**
 * Reference CAS consumer over a real CapTP connection
 * (DESIGN.md §6 — content-addressed-cache shortcut).
 *
 * The contract: a consumer that holds a CAS keyed by
 * `(algorithm, hash)` can answer reads locally and skip reading
 * the bytes off the `BlobRef` on cache hits. Byte reads now flow
 * through the whole-value `streamBase64` surface (the ranged
 * `fetch` primitive is retired; see
 * designs/readableblob-range-attenuation.md). These tests verify the
 * property by snapshotting the wire transcript for two
 * scenarios:
 *
 *   - **Cache miss** — first read of a new BlobRef. The
 *     transcript shows `BlobRef.getInfo` → `BlobRef.streamBase64`
 *     → bytes flowing over the wire. After the read, the CAS
 *     holds the bytes keyed by hash.
 *
 *   - **Cache hit** — second read of a BlobRef whose hash is
 *     already in the CAS. The transcript shows
 *     `BlobRef.getInfo` (still needed to learn the hash) but
 *     **no** `BlobRef.streamBase64` — the bytes are served from
 *     the local CAS. The byte stream does not cross the wire; the
 *     `getInfo` call still does. See ROADMAP §1.1 / §1.5 for what
 *     these in-process CapTP transcripts do and don't prove.
 *
 * Snapshot fixtures pin the contrast; assertions on the
 * transcript verify the "no byte stream on hit" property directly.
 */

import '@endo/init/debug.js';

import { createHash } from 'node:crypto';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { encodeBase64 } from '@endo/base64';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';
import { makeReaderPump } from '@endo/exo-stream/reader-pump.js';

import { makeInMemoryFilesystem } from '../src/fs/extended/in-memory.js';
import {
  makeMemoryCas,
  cacheBackedRead,
  MAX_FRAME_BASE64_LENGTH,
} from '../src/fs/extended/cas.js';
import { makeConnectedPair, settle } from './_captp-pair.js';

const utf8 = s => new TextEncoder().encode(s);
const fromUtf8 = b => new TextDecoder().decode(b);

const sha256Base64 = bytes =>
  encodeBase64(createHash('sha256').update(bytes).digest());

/**
 * A hand-rolled blob whose advertised `getInfo()` and streamed `streamBase64()`
 * frames are fully controllable, so a test can make the two DISAGREE — the
 * shape a malicious remote presents. `frames` is the exact sequence of base64
 * strings the stream yields.
 */
const makeFakeBlob = (info, frames) =>
  Far('FakeBlob', {
    getInfo: () => info,
    streamBase64: syn => {
      async function* generate() {
        for (const frame of frames) {
          yield frame;
        }
      }
      return makeReaderPump(generate())(syn);
    },
  });

const writeBytes = async (writerRef, bytes) => {
  const w = iterateBytesWriter(writerRef);
  await w.next(bytes);
  await w.return();
};

const populateFile = async (fs, name, contents) => {
  const root = await E(fs).root();
  const opened = await E(root).create(name, {});
  await writeBytes(await E(opened).write(0n), utf8(contents));
  await E(opened).close();
  return E(root).lookup(name);
};

// Trim the bootstrap-exchange entries off the front of a
// transcript so the snapshot/assertion focuses on the
// consumer's traffic.
const sliceAfterBootstrap = transcript => {
  // The bootstrap exchange is the first `CTP_BOOTSTRAP` plus its
  // matching `CTP_RETURN`. Drop both.
  const idx = transcript.findIndex(
    e => e.type === 'CTP_RETURN' && e.answerID === transcript[0].questionID,
  );
  return idx === -1 ? transcript : transcript.slice(idx + 1);
};

test('CAS-cached read: miss populates the CAS and streams over the wire', async t => {
  const fs = makeInMemoryFilesystem();
  await populateFile(fs, 'greet.txt', 'hello, world');
  const { bootstrapRef, transcript } = makeConnectedPair(fs);

  const cas = makeMemoryCas();
  t.is(cas.size, 0, 'CAS starts empty');

  const root = await E(bootstrapRef).root();
  const file = await E(root).lookup('greet.txt');
  const blob = await E(file).snapshot();
  const bytes = await cacheBackedRead(blob, cas);
  t.is(fromUtf8(bytes), 'hello, world');
  t.is(cas.size, 1, 'CAS now holds one blob');
  await settle();

  // The miss path called both `getInfo` and `streamBase64`.
  const issued = sliceAfterBootstrap(transcript);
  const methods = issued.filter(e => e.type === 'CTP_CALL').map(e => e.method);
  t.true(methods.includes('getInfo'), 'getInfo travels over the wire');
  t.true(
    methods.includes('streamBase64'),
    'streamBase64 travels over the wire on a miss',
  );

  t.snapshot(transcript, 'cache miss transcript (streamed over wire)');
});

test('CAS-cached read: hit serves locally, no byte stream crosses the wire', async t => {
  const fs = makeInMemoryFilesystem();
  await populateFile(fs, 'greet.txt', 'hello, world');
  const { bootstrapRef, transcript } = makeConnectedPair(fs);

  const cas = makeMemoryCas();

  // First read populates the CAS.
  const root = await E(bootstrapRef).root();
  const file1 = await E(root).lookup('greet.txt');
  const blob1 = await E(file1).snapshot();
  await cacheBackedRead(blob1, cas);
  await settle();
  t.is(cas.size, 1);
  const populateEnd = transcript.length;

  // Second read of the same bytes — hash matches, CAS hits, no
  // `streamBase64` should appear on the wire after this point.
  const file2 = await E(root).lookup('greet.txt');
  const blob2 = await E(file2).snapshot();
  const bytes = await cacheBackedRead(blob2, cas);
  t.is(fromUtf8(bytes), 'hello, world');
  t.is(cas.size, 1, 'CAS still holds exactly one blob');
  await settle();

  const hitTraffic = transcript.slice(populateEnd);
  const hitMethods = hitTraffic
    .filter(e => e.type === 'CTP_CALL')
    .map(e => e.method);
  t.true(
    hitMethods.includes('getInfo'),
    'getInfo still travels on a hit (the consumer needs the hash to look up)',
  );
  t.is(
    hitMethods.filter(m => m === 'streamBase64').length,
    0,
    'cache hit: no streamBase64 call crosses the wire',
  );

  t.snapshot(
    hitTraffic,
    'cache hit transcript (no streamBase64 crosses the wire)',
  );
});

test('different blobs in the same CAS stay distinct by hash', async t => {
  const fs = makeInMemoryFilesystem();
  await populateFile(fs, 'a.txt', 'alpha');
  await populateFile(fs, 'b.txt', 'beta');
  const { bootstrapRef } = makeConnectedPair(fs);
  const root = await E(bootstrapRef).root();

  const cas = makeMemoryCas();

  const aFile = await E(root).lookup('a.txt');
  const a = await cacheBackedRead(await E(aFile).snapshot(), cas);
  const bFile = await E(root).lookup('b.txt');
  const b = await cacheBackedRead(await E(bFile).snapshot(), cas);

  t.is(fromUtf8(a), 'alpha');
  t.is(fromUtf8(b), 'beta');
  t.is(cas.size, 2, 'distinct hashes occupy distinct CAS slots');
});

test('identical bytes from different files share a single CAS slot', async t => {
  const fs = makeInMemoryFilesystem();
  await populateFile(fs, 'one.txt', 'same bytes');
  await populateFile(fs, 'two.txt', 'same bytes');
  const { bootstrapRef } = makeConnectedPair(fs);
  const root = await E(bootstrapRef).root();

  const cas = makeMemoryCas();

  const oneFile = await E(root).lookup('one.txt');
  await cacheBackedRead(await E(oneFile).snapshot(), cas);
  const twoFile = await E(root).lookup('two.txt');
  await cacheBackedRead(await E(twoFile).snapshot(), cas);

  t.is(cas.size, 1, 'identical content → one CAS slot');
});

test('cacheBackedRead with { offset, length } returns a slice of the cached payload', async t => {
  // Whole-blob hits cache, range read is a slice of the cached bytes.
  const fs = makeInMemoryFilesystem();
  await populateFile(fs, 'long.txt', '0123456789abcdef');
  const { bootstrapRef, transcript } = makeConnectedPair(fs);
  const root = await E(bootstrapRef).root();
  const file = await E(root).lookup('long.txt');
  const blob = await E(file).snapshot();
  const cas = makeMemoryCas();

  // Miss: streams the whole blob, populates CAS.
  const head = await cacheBackedRead(blob, cas, { offset: 0n, length: 4n });
  t.is(fromUtf8(head), '0123');
  await settle();
  t.is(cas.size, 1);
  const afterMiss = transcript.length;

  // Hit: no byte stream on the wire; slice comes from cache.
  const tail = await cacheBackedRead(blob, cas, { offset: 10n, length: 6n });
  t.is(fromUtf8(tail), 'abcdef');
  await settle();
  const hitCalls = transcript
    .slice(afterMiss)
    .filter(e => e.type === 'CTP_CALL')
    .map(e => e.method);
  t.is(
    hitCalls.filter(m => m === 'streamBase64').length,
    0,
    'second-range read is served from the CAS — no streamBase64 crosses the wire',
  );
});

test('makeMemoryCas: LRU eviction drops the least-recently-used entry when over capacity', t => {
  const cas = makeMemoryCas({ capacity: 2 });
  const mk = h => ({ algorithm: 'sha256', hash: h, size: 0n });
  cas.put(mk('a'), new Uint8Array([1]));
  cas.put(mk('b'), new Uint8Array([2]));
  // Touch 'a' to make it most-recent.
  t.deepEqual([...(cas.get(mk('a')) || new Uint8Array())], [1]);
  // Inserting a third entry evicts 'b' (now LRU).
  cas.put(mk('c'), new Uint8Array([3]));
  t.is(cas.size, 2);
  t.true(cas.has(mk('a')));
  t.false(cas.has(mk('b')));
  t.true(cas.has(mk('c')));
});

test('makeMemoryCas: invalid capacity rejects', t => {
  t.throws(() => makeMemoryCas({ capacity: 0 }), { message: /positive/ });
  t.throws(() => makeMemoryCas({ capacity: -1 }), { message: /positive/ });
  t.throws(() => makeMemoryCas({ capacity: 1.5 }), { message: /positive/ });
});

test('cacheBackedRead range rejects out-of-bounds offset with EINVAL', async t => {
  const fs = makeInMemoryFilesystem();
  await populateFile(fs, 'small.txt', 'abc');
  const { bootstrapRef } = makeConnectedPair(fs);
  const root = await E(bootstrapRef).root();
  const blob = await E(await E(root).lookup('small.txt')).snapshot();
  const cas = makeMemoryCas();

  await t.throwsAsync(
    () => cacheBackedRead(blob, cas, { offset: 99n, length: 1n }),
    { message: /EINVAL/ },
  );
});

test('cacheBackedRead: an honest fake blob populates the CAS', async t => {
  const bytes = utf8('honest payload');
  const info = {
    algorithm: 'sha256',
    hash: sha256Base64(bytes),
    size: BigInt(bytes.length),
  };
  const blob = makeFakeBlob(info, [encodeBase64(bytes)]);
  const cas = makeMemoryCas();
  const out = await cacheBackedRead(blob, cas);
  t.is(fromUtf8(out), 'honest payload');
  t.is(cas.size, 1, 'verified bytes are cached');
});

test('cacheBackedRead: a digest lie is rejected and never cached', async t => {
  // Advertise the hash of DIFFERENT bytes (same length), then stream the
  // mismatching bytes. The size check passes; the digest check must catch it.
  const streamed = utf8('aaaaaaaa');
  const lie = utf8('bbbbbbbb');
  const info = {
    algorithm: 'sha256',
    hash: sha256Base64(lie),
    size: BigInt(streamed.length),
  };
  const blob = makeFakeBlob(info, [encodeBase64(streamed)]);
  const cas = makeMemoryCas();
  await t.throwsAsync(() => cacheBackedRead(blob, cas), {
    message: /content-address .* does not match/,
  });
  t.is(cas.size, 0, 'a forged content address never poisons the CAS');
});

test('cacheBackedRead: a size lie (streams fewer than advertised) is rejected', async t => {
  const streamed = utf8('short');
  const info = {
    algorithm: 'sha256',
    hash: sha256Base64(streamed),
    size: 1000n, // lie: claim far more than is streamed
  };
  const blob = makeFakeBlob(info, [encodeBase64(streamed)]);
  const cas = makeMemoryCas();
  await t.throwsAsync(() => cacheBackedRead(blob, cas), {
    message: /size .* does not match advertised size/,
  });
  t.is(cas.size, 0);
});

test('cacheBackedRead: a size lie (streams more than advertised) is cut off', async t => {
  const streamed = utf8('this is much longer than four bytes');
  const info = {
    algorithm: 'sha256',
    hash: sha256Base64(streamed),
    size: 4n, // lie: claim tiny so the drain must refuse to buffer the rest
  };
  const blob = makeFakeBlob(info, [encodeBase64(streamed)]);
  const cas = makeMemoryCas();
  await t.throwsAsync(() => cacheBackedRead(blob, cas), {
    message: /more than its advertised/,
  });
  t.is(cas.size, 0);
});

test('cacheBackedRead: a single oversized frame is rejected by the fixed bound', async t => {
  // One base64 frame longer than the fixed per-frame ceiling. A remote that
  // advertised a huge size could previously enlarge this ceiling; now it is a
  // constant, so the frame is refused regardless of the advertised size.
  const oversizedFrameLength =
    MAX_FRAME_BASE64_LENGTH + 4 - (MAX_FRAME_BASE64_LENGTH % 4);
  const oversizedFrame = 'A'.repeat(oversizedFrameLength);
  t.true(oversizedFrame.length > MAX_FRAME_BASE64_LENGTH);
  const info = {
    algorithm: 'sha256',
    // A plausible-looking (but here irrelevant) address; the frame is refused
    // before any bytes are decoded or hashed.
    hash: sha256Base64(utf8('unused')),
    size: BigInt((oversizedFrame.length / 4) * 3),
  };
  const blob = makeFakeBlob(info, [oversizedFrame]);
  const cas = makeMemoryCas();
  await t.throwsAsync(() => cacheBackedRead(blob, cas));
  t.is(cas.size, 0, 'an oversized frame never reaches the CAS');
});
