// @ts-check

// Establish a perimeter:

import '@endo/init/debug.js';

import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { E } from '@endo/eventual-send';
import { M, mustMatch } from '@endo/patterns';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { GLOB_MAX_RESULTS, GREP_MAX_RESULTS } from '@endo/platform/fs/lite';

import { makeFilePowers } from '../src/manager-node-powers.js';
import {
  makeMount,
  makeRevocableMount,
  clampStreamBuffer,
  STREAM_BUFFER_MAX,
} from '../src/mount.js';
import { buildMountFixture } from './_mount-fixture.js';

/**
 * Streaming mount-search tests for `streamGlob` / `streamGrep`
 * (designs/mount-stream-glob-grep.md). The walker was already refactored into
 * the shared platform search engine (`@endo/platform/fs/search`, batch
 * generators consumed by the eager `glob`/`grep` collectors), so these tests
 * cover the stream surface built over that engine: parity with the eager
 * variants, incrementality, backpressure, cancellation, mid-stream revocation,
 * confinement/denial parity, the self-describing pattern guard, and the option
 * / buffer-clamp behavior.
 */

const filePowers = makeFilePowers({ fs, path });

/**
 * @param {import('ava').ExecutionContext} t
 * @param {string} prefix
 */
const makeTempRoot = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/**
 * Wrap file powers with counters over the read powers, so a test can observe
 * how far a streaming grep walked. `readFileText` is the only power the search
 * engine uses to read file *contents*; the directory walk uses `readDirectory`.
 */
const countingPowers = () => {
  const counters = { readFileText: 0, readDirectory: 0 };
  const wrapped = {
    ...filePowers,
    readFileText: async p => {
      counters.readFileText += 1;
      return filePowers.readFileText(p);
    },
    readDirectory: async p => {
      counters.readDirectory += 1;
      return filePowers.readDirectory(p);
    },
  };
  // The default node powers carry no native `search`, so `provideSearch` builds
  // the JS engine over these individual powers — and thus over the counters. If
  // this ever regresses (a native `search` appears), the assertions below would
  // silently stop observing reads, so pin the precondition.
  if (/** @type {{ search?: unknown }} */ (wrapped).search !== undefined) {
    throw new Error('counting powers cannot observe a native search engine');
  }
  return { powers: harden(wrapped), counters };
};

/**
 * Collect a whole reader into an array (the eager equivalent of the stream).
 *
 * @param {any} reader
 * @returns {Promise<any[]>}
 */
const collect = async reader => {
  /** @type {any[]} */
  const out = [];
  for await (const element of iterateReader(reader)) {
    out.push(element);
  }
  return out;
};

// --- Parity: a collected stream reproduces the eager result, order included ---

test('streamGlob collected equals glob, in the same order', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  await null;
  const eager = [...(await E(mount).glob('**'))];
  const streamed = await collect(E(mount).streamGlob('**'));
  t.true(eager.length > 5, 'the fixture yields a non-trivial glob result');
  t.deepEqual(
    streamed,
    eager,
    'streamGlob reproduces glob element-for-element',
  );
});

test('streamGrep collected equals grep(pattern, glob(g)), in the same order', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  await null;
  const eager = [
    ...(await E(mount).grep('export', E(mount).glob('src/**/*.js'))),
  ];
  const streamed = await collect(
    E(mount).streamGrep('export', { glob: 'src/**/*.js' }),
  );
  t.true(eager.length > 1, 'the fixture yields several grep matches');
  t.deepEqual(
    streamed,
    eager,
    'streamGrep reproduces grep element-for-element',
  );
});

test('streamGrep with glob omitted searches the whole tree, equal to grep()', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  await null;
  const eager = [...(await E(mount).grep('line'))];
  const streamed = await collect(E(mount).streamGrep('line'));
  t.true(eager.length > 0);
  t.deepEqual(streamed, eager);
});

test('streamGlob on a subView is scoped to the sub-root, like glob', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  const sub = await E(mount).subView('src');
  const eager = [...(await E(sub).glob('**'))];
  const streamed = await collect(E(sub).streamGlob('**'));
  t.true(streamed.every(p => !p.startsWith('..')));
  t.deepEqual(streamed, eager);
});

// --- Incrementality: grep reads only as far as the consumer pulls ---

test('streamGrep is incremental: closing after one match leaves later files unread', async t => {
  const root = makeTempRoot(t, 'mount-stream-incr-');
  const total = 40;
  for (let i = 0; i < total; i += 1) {
    // Zero-padded so the sorted walk order is stable and every file matches.
    fs.writeFileSync(
      path.join(root, `f${String(i).padStart(3, '0')}.txt`),
      'needle here\n',
    );
  }
  const { powers, counters } = countingPowers();
  const mount = makeMount({
    rootPath: root,
    readOnly: false,
    filePowers: powers,
  });

  const iterator = iterateReader(E(mount).streamGrep('needle'));
  const first = await iterator.next();
  t.false(first.done, 'the stream produced a first match');
  t.is(
    /** @type {any} */ (first.value).file,
    'f000.txt',
    'the first match is the first file in sorted order',
  );
  // Only the files needed to produce the first match were read — not the tree.
  t.true(counters.readFileText >= 1);
  t.true(
    counters.readFileText < total,
    `read ${counters.readFileText} of ${total} files before the first pull`,
  );

  await iterator.return();
  const readsAtClose = counters.readFileText;
  // After closing, the abandoned walk does no further content reads.
  await null;
  await null;
  t.is(
    counters.readFileText,
    readsAtClose,
    'no files are read after the consumer closes the stream',
  );
});

// --- Backpressure: buffer 0 reads exactly one file per pull, none ahead ---

test('streamGrep with buffer 0 does not read ahead of demand', async t => {
  const root = makeTempRoot(t, 'mount-stream-bp-');
  const total = 20;
  for (let i = 0; i < total; i += 1) {
    fs.writeFileSync(
      path.join(root, `f${String(i).padStart(3, '0')}.txt`),
      'hit\n',
    );
  }
  const { powers, counters } = countingPowers();
  const mount = makeMount({
    rootPath: root,
    readOnly: false,
    filePowers: powers,
  });

  const iterator = iterateReader(E(mount).streamGrep('hit'));
  t.is(counters.readFileText, 0, 'no file is read before the first pull');

  await iterator.next();
  t.is(
    counters.readFileText,
    1,
    'the first pull reads exactly one file (every file matches)',
  );
  await iterator.next();
  t.is(counters.readFileText, 2, 'the second pull reads exactly one more file');

  await iterator.return();
});

// --- Cancellation: break out of for-await; walk stops, no unhandled rejection ---

test('breaking out of a streamGrep for-await stops the walk cleanly', async t => {
  const root = makeTempRoot(t, 'mount-stream-cancel-');
  const total = 30;
  for (let i = 0; i < total; i += 1) {
    fs.writeFileSync(
      path.join(root, `f${String(i).padStart(3, '0')}.txt`),
      'stop\n',
    );
  }
  const { powers, counters } = countingPowers();
  const mount = makeMount({
    rootPath: root,
    readOnly: false,
    filePowers: powers,
  });

  let seen = 0;
  for await (const match of iterateReader(E(mount).streamGrep('stop'))) {
    t.is(typeof match.file, 'string');
    seen += 1;
    if (seen === 1) {
      break; // triggers iterator.return() -> stops the remote walk
    }
  }
  t.is(seen, 1);
  const readsAtBreak = counters.readFileText;
  t.true(readsAtBreak < total, 'the break abandoned the walk before the end');

  // Let any stray continuation settle; ava fails the test on an unhandled
  // rejection, and the read counter must not advance after the break.
  await null;
  await null;
  t.is(counters.readFileText, readsAtBreak, 'no reads after cancellation');
});

// --- Revocation mid-stream: the next pull after revoke() rejects ---

test('streamGrep rejects the next pull after a mid-stream revoke', async t => {
  const root = makeTempRoot(t, 'mount-stream-revoke-');
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    fs.writeFileSync(path.join(root, name), 'live match\n');
  }
  const { mount, control } = makeRevocableMount({
    rootPath: root,
    readOnly: false,
    filePowers,
  });

  const iterator = iterateReader(E(mount).streamGrep('match'));
  const first = await iterator.next();
  t.false(first.done, 'a first match arrives before revocation');

  E(control).revoke();

  await t.throwsAsync(() => iterator.next(), {
    message: /Mount has been revoked/,
  });
});

test('streamGlob throws synchronously at invocation on an already-revoked mount', async t => {
  const root = makeTempRoot(t, 'mount-stream-revoke2-');
  fs.writeFileSync(path.join(root, 'a.txt'), 'x\n');
  const { mount, control } = makeRevocableMount({
    rootPath: root,
    readOnly: false,
    filePowers,
  });
  await E(control).revoke();
  await t.throwsAsync(() => E(mount).streamGlob('**'), {
    message: /Mount has been revoked/,
  });
  await t.throwsAsync(() => E(mount).streamGrep('x'), {
    message: /Mount has been revoked/,
  });
});

// --- Confinement and denial parity: secrets and escapes never surface ---

test('streamGlob never yields denied names or entries escaping the mount', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  const paths = await collect(E(mount).streamGlob('**'));
  const segments = paths.flatMap(p => p.split('/'));
  for (const denied of ['.ssh', '.aws', '.env', '.SSH', '.gnupg']) {
    t.false(
      segments.includes(denied),
      `${denied} must never appear in the stream`,
    );
  }
  t.false(
    paths.some(p => p.includes('escape-target')),
    'the escaping symlink target is never enumerated',
  );
  // The strongest statement: identical to the eager, already-filtered glob.
  t.deepEqual(paths, [...(await E(mount).glob('**'))]);
});

test('streamGrep never reads denied files or escaping symlinks', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  await null;
  // Every credential fixture file contains this sentinel; all are denied.
  t.deepEqual(
    await collect(E(mount).streamGrep('must-never-surface')),
    [],
    'denied files are never searched',
  );
  // The escaping symlink target (outside confinement) carries this text.
  t.deepEqual(
    await collect(E(mount).streamGrep('outside the mount')),
    [],
    'a symlink escaping the mount root is never followed',
  );
});

// --- Pattern guard: the reader self-describes its element shape ---

test('streamGlob readPattern is M.string() and every element matches it', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  const reader = E(mount).streamGlob('**');
  const pattern = await E(reader).readPattern();
  t.notThrows(() => mustMatch('src/index.js', pattern));
  t.throws(
    () => mustMatch(123, pattern),
    undefined,
    'a non-string is rejected',
  );
  for (const element of await collect(reader)) {
    mustMatch(element, pattern);
  }
  t.pass();
});

test('streamGrep readPattern is { file, line, text } and every element matches it', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  const reader = E(mount).streamGrep('export', { glob: 'src/**/*.js' });
  const pattern = await E(reader).readPattern();
  t.notThrows(() =>
    mustMatch(harden({ file: 'a', line: 1, text: 't' }), pattern),
  );
  t.throws(
    () => mustMatch(harden({ file: 'a', line: 'nope', text: 't' }), pattern),
    undefined,
    'a mistyped record is rejected',
  );
  for (const element of await collect(reader)) {
    mustMatch(element, pattern);
  }
  t.pass();
});

test('a stream element that violates the readPattern breaks the stream with an error', async t => {
  // The reader pump validates each element against readPattern via mustMatch,
  // so a hand-built reader over a mistyped element rejects rather than leaking
  // an ill-shaped value. This pins the guard the mount relies on.
  const { readerFromIterator } =
    await import('@endo/exo-stream/reader-from-iterator.js');
  const badReader = readerFromIterator(
    (async function* bad() {
      yield 42; // not a string
    })(),
    { readPattern: M.string() },
  );
  await t.throwsAsync(() => collect(badReader), {
    message: /Must be a string/,
  });
});

// --- readOnly semantics: streaming is a read, present on read-only mounts ---
// --- but excluded from the structural ReadableTree view. ---

test('a read-only mount still exposes streaming search (reads are allowed)', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: true, filePowers });
  const paths = await collect(E(mount).streamGlob('**'));
  t.true(paths.length > 0, 'streamGlob works on a read-only mount');
});

test('the readOnly() ReadableTree view does not carry streamGlob / streamGrep', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  // The view is a structural ReadableTree, which does not type these methods;
  // cast to reach them and assert the exo rejects the absent-method call.
  const view = /** @type {any} */ (await E(mount).readOnly());
  await t.throwsAsync(() => E(view).streamGlob('**'), {
    message: /streamGlob|no method|not/,
  });
  await t.throwsAsync(() => E(view).streamGrep('x'), {
    message: /streamGrep|no method|not/,
  });
});

// --- Options and the buffer clamp ---

test('clampStreamBuffer clamps a requested buffer to [0, STREAM_BUFFER_MAX]', t => {
  t.is(STREAM_BUFFER_MAX, 1024);
  t.is(clampStreamBuffer(0), 0);
  t.is(clampStreamBuffer(-5), 0, 'a negative request collapses to 0');
  t.is(clampStreamBuffer(10), 10);
  t.is(clampStreamBuffer(3.9), 3, 'a fractional request floors');
  t.is(
    clampStreamBuffer(STREAM_BUFFER_MAX + 1000),
    STREAM_BUFFER_MAX,
    'an oversized request is clamped to the ceiling',
  );
  t.is(clampStreamBuffer(Number.NaN), 0);
  t.is(clampStreamBuffer(Number.POSITIVE_INFINITY), 0);
  t.is(clampStreamBuffer(Number.NEGATIVE_INFINITY), 0);
  t.is(clampStreamBuffer(-0), 0, 'negative zero collapses to 0');
  t.is(
    clampStreamBuffer(STREAM_BUFFER_MAX),
    STREAM_BUFFER_MAX,
    'the exact ceiling passes through unclamped (the > vs === boundary)',
  );
  t.is(
    clampStreamBuffer(STREAM_BUFFER_MAX - 1),
    STREAM_BUFFER_MAX - 1,
    'just below the ceiling passes through',
  );
  t.is(clampStreamBuffer(undefined), 0);
});

test('streamGlob with an oversized buffer still yields the correct parity result', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  const streamed = await collect(
    E(mount).streamGlob('**', { buffer: 999_999 }),
  );
  t.deepEqual(streamed, [...(await E(mount).glob('**'))]);
});

test('the MountInterface guard rejects a non-number buffer', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  await t.throwsAsync(
    // @ts-expect-error deliberate bad option shape
    () => collect(E(mount).streamGlob('**', { buffer: 'lots' })),
    { message: /Must be a number/ },
  );
});

// --- No result cap: the streaming variants yield past the eager caps ---
// The whole reason the streaming surface exists is to move the boundary the
// eager `glob`/`grep` collectors truncate at. Pin that the eager forms stop at
// their cap while the stream keeps going. [corner-prober finding 1]

test('streamGrep yields past GREP_MAX_RESULTS while grep truncates at it', async t => {
  t.timeout(60_000);
  const root = makeTempRoot(t, 'mount-stream-grepcap-');
  // One file, more matching lines than the eager grep cap. Every line matches,
  // so the match count — not the file count — crosses the boundary cheaply.
  const overCap = GREP_MAX_RESULTS + 25;
  const lines = Array.from({ length: overCap }, () => 'needle').join('\n');
  fs.writeFileSync(path.join(root, 'many.txt'), `${lines}\n`);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  await null;

  const eager = [...(await E(mount).grep('needle'))];
  t.is(
    eager.length,
    GREP_MAX_RESULTS,
    'eager grep truncates at GREP_MAX_RESULTS',
  );

  const streamed = await collect(E(mount).streamGrep('needle'));
  t.is(
    streamed.length,
    overCap,
    'streamGrep yields every match, past the eager cap',
  );
  t.true(streamed.length > eager.length);
});

test('streamGlob yields past GLOB_MAX_RESULTS while glob truncates at it', async t => {
  t.timeout(120_000);
  const root = makeTempRoot(t, 'mount-stream-globcap-');
  // A flat directory just over the eager glob cap. Empty files keep this cheap;
  // `glob('*')` walks one directory and sorts the names, no recursion.
  const overCap = GLOB_MAX_RESULTS + 1;
  for (let i = 0; i < overCap; i += 1) {
    fs.writeFileSync(path.join(root, `f${String(i).padStart(6, '0')}`), '');
  }
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  await null;

  const eager = [...(await E(mount).glob('*'))];
  t.is(
    eager.length,
    GLOB_MAX_RESULTS,
    'eager glob truncates at GLOB_MAX_RESULTS',
  );

  const streamed = await collect(E(mount).streamGlob('*'));
  t.is(
    streamed.length,
    overCap,
    'streamGlob yields every path, past the eager cap',
  );
  t.true(streamed.length > eager.length);
});

// --- Buffer clamp is enforced at the call site, not merely unit-tested ---
// `clampStreamBuffer` is exercised in isolation above; this observes that the
// producer's actual pre-ack read-ahead is bounded to STREAM_BUFFER_MAX when a
// caller requests more. If a regression dropped the clamp at the call site, the
// producer would read the whole (over-ceiling) fixture ahead of demand and this
// would redden. [prover finding; corner-prober finding 3]

test('streamGrep clamps producer read-ahead to STREAM_BUFFER_MAX', async t => {
  t.timeout(120_000);
  const root = makeTempRoot(t, 'mount-stream-clamp-');
  // More one-match files than the ceiling, so "clamped to 1024" is observably
  // distinct from "reads them all". One matching line per file ⇒ one element
  // (and one readFileText) per file.
  const total = STREAM_BUFFER_MAX + 100;
  for (let i = 0; i < total; i += 1) {
    fs.writeFileSync(
      path.join(root, `f${String(i).padStart(5, '0')}.txt`),
      'needle\n',
    );
  }
  const { powers, counters } = countingPowers();
  const mount = makeMount({
    rootPath: root,
    readOnly: false,
    filePowers: powers,
  });
  await null;

  // Request a buffer far above the ceiling and DON'T pull: the producer pre-acks
  // up to its clamped buffer, then blocks awaiting a synchronize node.
  const iterator = iterateReader(
    E(mount).streamGrep('needle', { buffer: STREAM_BUFFER_MAX * 4 }),
  );
  // Let the producer run until its pre-ack read-ahead settles (it cannot exceed
  // the clamp), then a grace window in which a broken clamp would over-read.
  for (
    let waited = 0;
    counters.readFileText < STREAM_BUFFER_MAX && waited < 400;
    waited += 1
  ) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await new Promise(resolve => setTimeout(resolve, 100));

  t.is(
    counters.readFileText,
    STREAM_BUFFER_MAX,
    `producer read-ahead is clamped to STREAM_BUFFER_MAX (${STREAM_BUFFER_MAX}), not the requested ${STREAM_BUFFER_MAX * 4} nor the unbounded ${total}`,
  );

  await iterator.return();
});

// --- Revocation is not atomic with buffer > 0: the window is bounded ---
// A non-zero buffer lets the producer pre-acknowledge settled elements ahead of
// demand; a mid-stream revoke() cannot un-deliver those. Pin the worst case:
// the post-revoke delivery is bounded by the clamped buffer, and the stream
// still eventually rejects. [breaker finding 1]

test('streamGrep with buffer > 0 bounds post-revoke delivery to the clamped buffer', async t => {
  const root = makeTempRoot(t, 'mount-stream-revoke-buf-');
  const total = 40;
  for (let i = 0; i < total; i += 1) {
    fs.writeFileSync(
      path.join(root, `f${String(i).padStart(3, '0')}.txt`),
      'match\n',
    );
  }
  const { mount, control } = makeRevocableMount({
    rootPath: root,
    readOnly: false,
    filePowers,
  });

  const buffer = 4;
  const iterator = iterateReader(E(mount).streamGrep('match', { buffer }));
  const first = await iterator.next();
  t.false(first.done, 'a first match arrives before revocation');

  // Revoke while the producer is pre-acking ahead. Elements already settled into
  // the buffer are still deliverable; only the pull past the drained buffer
  // rejects. This is the documented revocation-latency window.
  await E(control).revoke();

  let delivered = 0;
  let rejected = false;
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const next = await iterator.next();
      if (next.done) break;
      delivered += 1;
      // Safety valve so a broken clamp cannot loop forever.
      if (delivered > buffer + 5) break;
    }
  } catch (error) {
    rejected = true;
    t.regex(error.message, /Mount has been revoked/);
  }

  t.true(rejected, 'the stream rejects once the pre-acked buffer drains');
  t.true(
    delivered <= clampStreamBuffer(buffer),
    `at most the clamped buffer (${clampStreamBuffer(
      buffer,
    )}) elements arrive after revoke; got ${delivered}`,
  );
});

// --- Directory walk is eager, content reads are incremental (asymmetric) ---
// The design aspired to a fully incremental walk, but glob's global sort forces
// the whole confined tree to be enumerated before the first element — for
// streamGrep too, since its file list comes from the same walk. Pin the shipped
// reality the corrected docs now describe: at the first match the directory walk
// is already complete, yet only the files needed for that match were read.
// [engine-realist finding]

test('streamGrep enumerates the whole tree before the first match, but reads only as far as needed', async t => {
  const root = makeTempRoot(t, 'mount-stream-deep-');
  // A match at the root (sorts first) and a chain of nested directories whose
  // deepest file also matches. The walk must descend the whole chain regardless
  // of where the first match sorts.
  fs.writeFileSync(path.join(root, 'aaa.txt'), 'deep-needle\n');
  let dir = root;
  const depth = 10;
  for (let i = 0; i < depth; i += 1) {
    dir = path.join(dir, `d${i}`);
    fs.mkdirSync(dir);
  }
  fs.writeFileSync(path.join(dir, 'deep.txt'), 'deep-needle\n');

  // Learn the full-walk directory-read count from a complete streamGlob pass.
  const glob = countingPowers();
  const globMount = makeMount({
    rootPath: root,
    readOnly: false,
    filePowers: glob.powers,
  });
  await collect(E(globMount).streamGlob('**'));
  const fullWalkDirReads = glob.counters.readDirectory;
  t.true(fullWalkDirReads >= depth, 'the fixture is genuinely deep');

  const { powers, counters } = countingPowers();
  const mount = makeMount({
    rootPath: root,
    readOnly: false,
    filePowers: powers,
  });
  const iterator = iterateReader(E(mount).streamGrep('deep-needle'));
  const firstMatch = await iterator.next();
  t.false(firstMatch.done);
  t.is(
    /** @type {any} */ (firstMatch.value).file,
    'aaa.txt',
    'the root file sorts first',
  );

  // The directory walk is eager: at the first match the whole tree has already
  // been enumerated (same directory reads as a full glob walk).
  t.is(
    counters.readDirectory,
    fullWalkDirReads,
    'the whole confined tree is walked before the first match (eager walk)',
  );
  // But content reads are incremental: only the first file was read, not the
  // deep one still pending in the walk order.
  t.is(counters.readFileText, 1, 'only the first match file was read');

  await iterator.return();
  await null;
  await null;
  t.is(counters.readFileText, 1, 'early close leaves the deep file unread');
});

// --- streamGlob early cancellation: return() cleans up before completion ---
// [corner-prober finding 5: streamGlob had zero cancellation coverage]

test('breaking out of a streamGlob for-await stops cleanly with no late reads', async t => {
  const { root } = buildMountFixture(t);
  const { powers, counters } = countingPowers();
  const mount = makeMount({
    rootPath: root,
    readOnly: false,
    filePowers: powers,
  });

  let seen = 0;
  for await (const p of iterateReader(E(mount).streamGlob('**'))) {
    t.is(typeof p, 'string');
    seen += 1;
    if (seen === 1) {
      break; // triggers iterator.return()
    }
  }
  t.is(seen, 1);
  const dirReadsAtBreak = counters.readDirectory;
  await null;
  await null;
  t.is(
    counters.readDirectory,
    dirReadsAtBreak,
    'no directory reads after cancellation',
  );
});

// --- streamGrep with a glob matching zero files yields nothing ---
// [corner-prober finding 6]

test('streamGrep with a glob that matches no file yields an empty stream', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  await null;
  t.deepEqual(
    await collect(
      E(mount).streamGrep('export', { glob: 'no-such-dir/**/*.nope' }),
    ),
    [],
    'a glob matching nothing produces no matches',
  );
});
