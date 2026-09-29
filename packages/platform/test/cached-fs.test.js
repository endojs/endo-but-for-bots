// @ts-nocheck
/* eslint-disable import/order, no-await-in-loop */

/**
 * Transparent CAS-cached `Filesystem` wrapper over a real CapTP
 * connection (DESIGN.md §6, ROADMAP §2.2).
 *
 * `withCachedReads(fs, cas)` is a `Filesystem → Filesystem`
 * transformation that drops into the existing composition algebra.
 * Its read path dispatches `snapshot`, metadata accessors, and the underlying
 * `read` as a single pipelined CapTP batch, so each wrapper `read`
 * costs exactly one round-trip — same as a plain (uncached) read.
 *
 * Tests:
 *
 *   - **Cache miss** — first read of a file. The transcript shows
 *     `snapshot` + metadata + `read` issued in one batch, then the
 *     background cache populate (`fetch` + a byte-array `stream`). The
 *     speculative `read`'s bytes flow to the caller; the
 *     populating `fetch` runs after the caller has already received
 *     the response.
 *
 *   - **Cache hit** — second read of a file whose hash is in the
 *     CAS. The transcript shows `snapshot` + metadata + a
 *     speculative `read` invocation, but the bytes from that
 *     speculative read **never flow** (`@endo/exo-stream` is
 *     pull-based; the wrapper returns a different reader and the
 *     speculative one is GC'd unused). Concrete assertion: the
 *     hit-side transcript carries no `stream` CTP_CALL.
 *
 *   - **No extra RTT** — by the time the caller's `await` resolves,
 *     the wire has carried exactly one `read` round-trip and the
 *     bytes are in hand. The miss/hit transcript snapshots pin
 *     this directly.
 */

import '@endo/init/debug.js';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { thawedBytes } from '@endo/immutable-arraybuffer';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { makeInMemoryFilesystem } from '../src/fs/extended/in-memory.js';
import { makeNodeFilesystem } from '../src/fs/extended/node-fs.js';
import { makeMemoryCas } from '../src/fs/extended/cas.js';
import { withCachedReads } from '../src/fs/extended/cached-fs.js';
import { makeConnectedPair, settle } from './_captp-pair.js';

const utf8 = s => new TextEncoder().encode(s);
const fromUtf8 = b => new TextDecoder().decode(b);

const isCall = method => event =>
  event.type === 'CTP_CALL' && event.method === method;

/**
 * Find the `CTP_RETURN` that answers `call`. CapTP question IDs are minted
 * per side, so require the return to travel in the reverse direction of the
 * call as well as match its question ID.
 *
 * @param {Array<Record<string, unknown>>} transcript
 * @param {Record<string, unknown>} call
 * @returns {number} the index of the answering return, or -1 if none
 */
const findReturnIndex = (transcript, call) =>
  transcript.findIndex(
    event =>
      event.type === 'CTP_RETURN' &&
      event.answerID === call.questionID &&
      event.from === call.to &&
      event.to === call.from,
  );

/**
 * Canonicalize the one race observed in the cache-miss transcript.
 *
 * The miss path issues three `stream` calls: first the caller's drain of the
 * speculative read, then the background populate, then the watcher's drain of
 * its `events` reader. It also issues one watcher `events` call. The
 * caller-drain stream and the watcher subscription are independent, so the
 * caller-drain `stream` return can settle before or after the `events`
 * return. The
 * canonical order, the one recorded in the snapshot, puts the `events` return
 * first. If the stream return landed earlier, move it to the slot immediately
 * after the `events` return. No event is dropped, and every other event keeps
 * its relative order.
 *
 * The transform throws if the transcript does not have the shape it assumes,
 * so a changed scenario fails with a clear message instead of an unexplained
 * snapshot mismatch.
 *
 * @param {Array<Record<string, unknown>>} transcript
 * @returns {Array<Record<string, unknown>>} a reordered copy; the input is
 *   not mutated
 */
const canonicalizeStreamEventsRace = transcript => {
  const eventsCalls = transcript.filter(isCall('events'));
  if (eventsCalls.length !== 1) {
    throw Error(
      `expected exactly one watcher events call, got ${eventsCalls.length}`,
    );
  }
  const streamCalls = transcript.filter(isCall('stream'));
  if (streamCalls.length !== 3) {
    throw Error(
      `expected three stream calls (caller drain, background populate, watcher events), got ${streamCalls.length}`,
    );
  }
  // The caller drains the speculative read before the background populate
  // or the watcher opens its own stream, so the first `stream` call is the
  // caller's.
  const [eventsCall] = eventsCalls;
  const [drainCall] = streamCalls;

  const stable = [...transcript];
  const eventsReturnAt = findReturnIndex(stable, eventsCall);
  const drainReturnAt = findReturnIndex(stable, drainCall);
  if (eventsReturnAt < 0) {
    throw Error(`no return for events call ${eventsCall.questionID}`);
  }
  if (drainReturnAt < 0) {
    throw Error(`no return for stream call ${drainCall.questionID}`);
  }
  if (drainReturnAt < eventsReturnAt) {
    const [drainReturn] = stable.splice(drainReturnAt, 1);
    // Removing the earlier return shifts the events return back one slot, so
    // its original index is now the slot immediately after it.
    stable.splice(eventsReturnAt, 0, drainReturn);
  }
  return stable;
};

const writeBytes = async (writerRef, bytes) => {
  const w = iterateBytesWriter(writerRef);
  await w.next(bytes);
  await w.return();
};

const collectBytes = async readerRef => {
  const chunks = [];
  let total = 0;
  for await (const chunk of iterateReader(readerRef)) {
    // Thaw each passable byte array: under the immutable-ArrayBuffer shim a
    // frozen chunk is not a genuine view, so `out.set` would copy zeros.
    const bytes = thawedBytes(/** @type {Uint8Array} */ (chunk));
    chunks.push(bytes);
    total += bytes.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
};

const populateFile = async (fs, name, contents) => {
  const root = await E(fs).root();
  const opened = await E(root).create(name, {});
  await writeBytes(await E(opened).write(0n), utf8(contents));
  await E(opened).close();
};

test('withCachedReads: miss serves speculative read in one RTT batch, populates cache in background', async t => {
  const innerFs = makeInMemoryFilesystem();
  await populateFile(innerFs, 'greet.txt', 'hello, world');
  const { bootstrapRef, transcript } = makeConnectedPair(innerFs);

  const cas = makeMemoryCas();
  const fs = withCachedReads(bootstrapRef, cas);

  // Drain the bootstrap exchange so the snapshot below focuses on
  // the wrapper traffic.
  await E(fs).root();

  const root = await E(fs).root();
  const file = await E(root).lookup('greet.txt');
  const oh = await E(file).open({ read: true });

  // Checkpoint right before the wrapper's read call so the
  // assertion below isolates the read's batch from the lookup /
  // open / getQid traffic.
  const beforeRead = transcript.length;
  const reader = await E(oh).read(0n, 64n);
  const bytes = await collectBytes(reader);
  t.is(fromUtf8(bytes), 'hello, world');

  // Wait long enough for the background cache populate to finish
  // so the snapshot captures both the miss read and the populate.
  await settle(20);

  t.is(cas.size, 1, 'CAS populated after the miss');

  // The wrapper's miss path issues `snapshot` + metadata calls +
  // (speculative) `read` in a single pipelined batch. Verify all
  // three CTP_CALLs appear in the read's segment of the
  // transcript before any reply to them lands.
  const readSegment = transcript.slice(beforeRead);
  const firstReturnAt = readSegment.findIndex(e => e.type === 'CTP_RETURN');
  const callsBefore = readSegment
    .slice(0, firstReturnAt)
    .filter(e => e.type === 'CTP_CALL')
    .map(e => e.method);
  t.true(
    callsBefore.includes('snapshot'),
    `snapshot in pipelined batch, got ${callsBefore.join(', ')}`,
  );
  t.true(
    callsBefore.includes('sha256') && callsBefore.includes('size'),
    `sha256 and size in pipelined batch, got ${callsBefore.join(', ')}`,
  );
  t.true(
    callsBefore.includes('read'),
    `speculative read in pipelined batch, got ${callsBefore.join(', ')}`,
  );

  const stableTranscript = canonicalizeStreamEventsRace(transcript);

  t.snapshot(
    stableTranscript,
    'miss transcript: speculative read + background populate',
  );
});

test('canonicalizeStreamEventsRace: a raced miss transcript canonicalizes to the snapshot order', t => {
  const call = (method, questionID, target) => ({
    from: 'left',
    method,
    questionID,
    target,
    to: 'right',
    type: 'CTP_CALL',
  });
  const makeReturn = answerID => ({
    answerID,
    from: 'right',
    to: 'left',
    type: 'CTP_RETURN',
  });
  const resolve = (from, to) => ({ from, to, type: 'CTP_RESOLVE' });

  // The tail of the recorded miss transcript, in snapshot order.
  const canonical = [
    call('stream', 'q-15', 'o-6'),
    call('events', 'q-16', 'o-7'),
    call('stream', 'q-17', 'o-8'),
    resolve('left', 'right'),
    resolve('left', 'right'),
    makeReturn('q-16'),
    makeReturn('q-15'),
    call('stream', 'q-18', 'o-9'),
    makeReturn('q-17'),
    resolve('left', 'right'),
    resolve('right', 'left'),
  ];
  // The raced shape: the caller-drain stream returns before the watcher
  // `events` call is even issued.
  const raced = [
    canonical[0],
    makeReturn('q-15'),
    ...canonical.slice(1, 6),
    ...canonical.slice(7),
  ];
  t.notDeepEqual(raced, canonical);
  t.deepEqual(canonicalizeStreamEventsRace(raced), canonical);
  // The canonical order is a fixed point.
  t.deepEqual(canonicalizeStreamEventsRace(canonical), canonical);

  // A same-numbered question minted by the other side is not the answer to
  // the caller-drain call, so the return must travel right-to-left.
  const forged = canonical.map(event =>
    event.type === 'CTP_RETURN' && event.answerID === 'q-15'
      ? { ...event, from: 'left', to: 'right' }
      : event,
  );
  t.throws(() => canonicalizeStreamEventsRace(forged), {
    message: /no return for stream call q-15/,
  });

  // The transform refuses shapes it does not understand.
  t.throws(
    () =>
      canonicalizeStreamEventsRace([
        ...canonical,
        call('stream', 'q-19', 'o-10'),
      ]),
    { message: /expected three stream calls/ },
  );
  t.throws(
    () =>
      canonicalizeStreamEventsRace([
        ...canonical,
        call('events', 'q-19', 'o-10'),
      ]),
    { message: /expected exactly one watcher events call/ },
  );
});

test('withCachedReads: hit returns cached bytes without flowing the speculative read', async t => {
  const innerFs = makeInMemoryFilesystem();
  await populateFile(innerFs, 'greet.txt', 'hello, world');
  const { bootstrapRef, transcript } = makeConnectedPair(innerFs);

  const cas = makeMemoryCas();
  const fs = withCachedReads(bootstrapRef, cas);

  // Prime the cache with a first read; settle the background
  // populate.
  await E(fs).root();
  const rootP1 = await E(fs).root();
  const fileP1 = await E(rootP1).lookup('greet.txt');
  const ohP1 = await E(fileP1).open({ read: true });
  await collectBytes(await E(ohP1).read(0n, 64n));
  await settle(20);
  t.is(cas.size, 1, 'cache populated after the first read');
  const primingEnd = transcript.length;

  // Second read of the same content. The wrapper should serve
  // from the CAS; the speculative read's bytes must not flow.
  const root = await E(fs).root();
  const file = await E(root).lookup('greet.txt');
  const oh = await E(file).open({ read: true });
  const reader = await E(oh).read(0n, 64n);
  const bytes = await collectBytes(reader);
  t.is(fromUtf8(bytes), 'hello, world');
  await settle(5);

  const hitTraffic = transcript.slice(primingEnd);
  const hitMethods = hitTraffic
    .filter(e => e.type === 'CTP_CALL')
    .map(e => e.method);

  // The wrapper still dispatches snapshot + metadata + read in a batch.
  t.true(hitMethods.includes('snapshot'));
  t.true(hitMethods.includes('sha256'));
  t.true(hitMethods.includes('size'));
  t.true(hitMethods.includes('read'));

  // The hit signature: the speculative read's PassableBytesReader
  // is never iterated, so no byte `stream` CALL ever crosses the
  // wire. This is what makes the cache hit a real win — the bytes
  // themselves never travel. The freshly looked-up File starts its own
  // watcher, whose `events` reader is drained with `stream` too, so
  // every `stream` call must be accounted for by an `events` call.
  t.is(hitMethods.filter(m => m === 'streamBase64').length, 0);
  t.is(
    hitMethods.filter(m => m === 'stream').length,
    hitMethods.filter(m => m === 'events').length,
    "speculative reader is GC'd unused; no byte stream on the wire",
  );

  t.snapshot(
    hitTraffic,
    'hit transcript: snapshot + metadata + speculative read, no byte stream',
  );
});

test('withCachedReads: distinct files with the same content share one CAS slot', async t => {
  const innerFs = makeInMemoryFilesystem();
  await populateFile(innerFs, 'one.txt', 'same bytes');
  await populateFile(innerFs, 'two.txt', 'same bytes');
  const { bootstrapRef } = makeConnectedPair(innerFs);

  const cas = makeMemoryCas();
  const fs = withCachedReads(bootstrapRef, cas);

  const root = await E(fs).root();

  for (const name of ['one.txt', 'two.txt']) {
    const file = await E(root).lookup(name);
    const oh = await E(file).open({ read: true });
    await collectBytes(await E(oh).read(0n, 64n));
  }
  await settle(20);

  t.is(cas.size, 1, 'identical content → one CAS slot');
});

test('withCachedReads: subsequent reads of different ranges of the same file all hit', async t => {
  const innerFs = makeInMemoryFilesystem();
  await populateFile(innerFs, 'long.txt', 'a'.repeat(1024));
  const { bootstrapRef, transcript } = makeConnectedPair(innerFs);

  const cas = makeMemoryCas();
  const fs = withCachedReads(bootstrapRef, cas);

  const root = await E(fs).root();
  const file = await E(root).lookup('long.txt');
  const oh = await E(file).open({ read: true });

  // Prime the cache.
  await collectBytes(await E(oh).read(0n, 128n));
  await settle(20);
  const primedEnd = transcript.length;

  // Range reads from the cached content.
  const headBytes = await collectBytes(await E(oh).read(0n, 16n));
  t.is(headBytes.length, 16);
  const tailBytes = await collectBytes(await E(oh).read(1008n, 16n));
  t.is(tailBytes.length, 16);
  await settle(5);

  // Range reads after the priming should all be hits — no
  // byte stream should travel.
  const subsequent = transcript.slice(primedEnd);
  const streamCalls = subsequent.filter(
    e =>
      e.type === 'CTP_CALL' &&
      (e.method === 'stream' || e.method === 'streamBase64'),
  );
  t.is(
    streamCalls.length,
    0,
    'range reads after cache populate are all hits — no bytes on the wire',
  );
});

test('withCachedReads: subsequent reads through the same File cap skip snapshot metadata (zero RTT on hit)', async t => {
  // After the first read warms both the CAS and the per-File hash
  // cache, a second read on the *same* File cap should serve the
  // bytes locally without issuing snapshot/metadata/read.
  const innerFs = makeInMemoryFilesystem();
  await populateFile(innerFs, 'greet.txt', 'hello, world');
  const { bootstrapRef, transcript } = makeConnectedPair(innerFs);

  const cas = makeMemoryCas();
  const fs = withCachedReads(bootstrapRef, cas);

  const root = await E(fs).root();
  const file = await E(root).lookup('greet.txt');
  const oh = await E(file).open({ read: true });

  // Prime: first read populates the CAS and the per-File hash.
  await collectBytes(await E(oh).read(0n, 64n));
  await settle(20);
  const afterPrime = transcript.length;

  // Second read on the same File-derived OpenFile. The hash is
  // known, no watcher event has fired, the CAS holds the payload —
  // so no CTP_CALL crosses the wire from the read path.
  const bytes = await collectBytes(await E(oh).read(0n, 64n));
  t.is(fromUtf8(bytes), 'hello, world');
  await settle(5);

  const secondCalls = transcript
    .slice(afterPrime)
    .filter(e => e.type === 'CTP_CALL')
    .map(e => e.method);
  t.deepEqual(
    secondCalls,
    [],
    'zero-RTT second read: no snapshot/metadata/read crosses the wire',
  );
});

test('withCachedReads: rename across wrapped directories unwraps the destination', async t => {
  // The disk-backed `node-fs.js` identifies the rename destination
  // by a private `WeakMap` keyed on the underlying Directory exo.
  // A wrapped Directory is a different exo, so passing it through
  // unchanged would raise EXDEV. The wrapper must unwrap before
  // forwarding.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cached-fs-rename-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const innerFs = makeNodeFilesystem({ rootPath: dir });
  const innerRoot = await E(innerFs).root();
  const opened = await E(innerRoot).create('moveme.txt', {});
  await E(opened).close();
  await E(innerRoot).mkdir('subdir', {});

  const cas = makeMemoryCas();
  const fs = withCachedReads(innerFs, cas);

  const root = await E(fs).root();
  const subdir = await E(root).lookup('subdir');

  // The destination here is the wrapped Directory cap from the
  // cached-fs wrapper. Without the unwrap, the underlying
  // node-fs.rename would surface EXDEV.
  await E(root).rename('moveme.txt', subdir, 'moved.txt');

  const after = await E(subdir).lookup('moved.txt');
  t.is((await E(after).getAttrs()).size, 0n);
});

test('withCachedReads: lookupStep / subView / move / copy work through the cache wrapper', async t => {
  // Drive the wrapper directly (no CapTP pair needed) to confirm the
  // new catalog verbs are forwarded and their results are re-wrapped,
  // not dropped or returned as bare inner caps.
  const fs = withCachedReads(makeInMemoryFilesystem(), makeMemoryCas());
  const root = await E(fs).root();
  const a = await E(root).makeDirectory('a', {});
  await E(a).write('f.txt', 'leaf');

  // lookupStep: single-segment, same node as lookup('a').
  const stepped = await E(root).lookupStep('a');
  const looked = await E(root).lookup('a');
  t.is((await E(stepped).getQid()).pathId, (await E(looked).getQid()).pathId);

  // subView: confined directory, resolves children through the wrapper.
  const view = await E(root).subView('a');
  t.is((await E(view).getQid()).type, 'directory');
  const viewedFile = await E(view).lookup('f.txt');
  t.is(fromUtf8(await collectBytes(await E(viewedFile).read())), 'leaf');

  // copy: path-to-path, source survives.
  await E(root).copy(['a', 'f.txt'], ['a', 'g.txt']);
  const copied = await E(root).lookup(['a', 'g.txt']);
  t.is(fromUtf8(await collectBytes(await E(copied).read())), 'leaf');
  t.truthy(await E(root).lookup(['a', 'f.txt']));

  // move: relocates and removes source.
  await E(root).move(['a', 'g.txt'], ['a', 'h.txt']);
  await t.throwsAsync(() => E(root).lookup(['a', 'g.txt']), {
    message: /ENOENT/,
  });
  const moved = await E(root).lookup(['a', 'h.txt']);
  t.is(fromUtf8(await collectBytes(await E(moved).read())), 'leaf');
});
