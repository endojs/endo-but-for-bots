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
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';

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
 * variants, `streamGrep`'s content-read incrementality, backpressure,
 * cancellation, mid-stream revocation, confinement/denial parity, the
 * self-describing pattern guard, and the buffer-clamp behavior.
 *
 * `streamGrep` is decoupled from enumeration (PR #1085 review): it takes a
 * *mandatory* external stream of files to grep — a `PassableReader<string>`, the
 * shape `streamGlob` returns — and never globs internally. "Search everything"
 * and "search a glob subset" are `streamGrep(p, streamGlob('**'))` and
 * `streamGrep(p, streamGlob(g))`, mirroring the eager `grep(pattern, glob(g))`
 * seam. Because the walk moved to the producer and `streamGlob` keeps glob's
 * eager global sort, `streamGrep(p, streamGlob('**'))` is not walk-incremental
 * (the producer walks fully before its first path); grep's own incrementality is
 * in the *content reads* of the supplied files. Walk-incremental grep would need
 * an unsorted producer, a flagged follow-up.
 */

/**
 * A hand-built `PassableReader<string>` over a fixed list of mount-relative
 * paths — the decoupled `files` source `streamGrep` greps, standing in for a
 * producer like `streamGlob`. Once-only, like the mount's own search readers.
 *
 * @param {readonly string[]} paths
 */
const readerOfPaths = paths =>
  readerFromIterator(
    (async function* pathsGen() {
      for (const p of paths) {
        yield p;
      }
    })(),
    { readPattern: M.string(), once: true },
  );

/** An empty once-only reader, for call sites that reject before consuming it. */
const emptyReader = () => readerOfPaths([]);

const filePowers = makeFilePowers({ fs, path });

/**
 * @param {import('ava').ExecutionContext} t
 * @param {string} prefix
 */
const makeTemporaryRoot = (t, prefix) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.teardown(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

/**
 * Wrap file powers with counters over the read powers, so a test can observe
 * how far a streaming grep walked. `readFileText` is the only power the search
 * engine uses to read file *contents*; the directory walk uses `readDirectory`.
 */
const makeCountingPowers = () => {
  const counters = { readFileText: 0, readDirectory: 0 };
  const wrapped = {
    ...filePowers,
    readFileText: async filePath => {
      counters.readFileText += 1;
      return filePowers.readFileText(filePath);
    },
    readDirectory: async filePath => {
      counters.readDirectory += 1;
      return filePowers.readDirectory(filePath);
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

/**
 * Canonicalize grep records into a stable (path, then line) order so a
 * multiset comparison is order-independent. Fed `streamGlob(g)`, `streamGrep`'s
 * cross-file order is the producer's — glob's UTF-16 sorted-path order — so it
 * would in fact match eager `grep(pattern, glob(g))` element-for-element; the
 * multiset comparison is the robust statement (same records, one per matched
 * line per file) and stays correct if a future unsorted producer changes the
 * cross-file order. Order *within* a single file (line order) is still normative
 * and preserved directly.
 *
 * @param {Array<{ file: string, line: number }>} records
 * @returns {Array<{ file: string, line: number }>}
 */
const byFileThenLine = records =>
  [...records].sort((a, b) => {
    if (a.file !== b.file) {
      return a.file < b.file ? -1 : 1;
    }
    return a.line - b.line;
  });

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

test('streamGrep collected equals grep(pattern, glob(g)) as a multiset', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  await null;
  const eager = [
    ...(await E(mount).grep('export', E(mount).glob('src/**/*.js'))),
  ];
  const streamed = await collect(
    E(mount).streamGrep('export', E(mount).streamGlob('src/**/*.js')),
  );
  t.true(eager.length > 1, 'the fixture yields several grep matches');
  // streamGrep composes with streamGlob(g); the record sets are multiset-equal
  // with eager grep(pattern, glob(g)).
  t.deepEqual(
    byFileThenLine(streamed),
    byFileThenLine(eager),
    'streamGrep reproduces every grep record (compared as a multiset)',
  );
});

test('streamGrep(p, streamGlob("**")) searches the whole tree, equal to grep() as a multiset', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  await null;
  const eager = [...(await E(mount).grep('line'))];
  const streamed = await collect(
    E(mount).streamGrep('line', E(mount).streamGlob('**')),
  );
  t.true(eager.length > 0);
  t.deepEqual(byFileThenLine(streamed), byFileThenLine(eager));
});

// --- Decoupling: streamGrep greps whatever file stream it is handed ---
// The reviewer's contract (PR #1085): grep takes a mandatory input stream of
// files and does not glob. Feed it a hand-built reader over a chosen subset and
// assert it greps exactly those files — the composition seam, independent of any
// producer.

test('streamGrep greps exactly the files a supplied stream carries', async t => {
  const root = makeTemporaryRoot(t, 'mount-stream-decoupled-');
  fs.writeFileSync(path.join(root, 'a.txt'), 'needle in a\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'needle in b\n');
  fs.writeFileSync(path.join(root, 'c.txt'), 'needle in c\n');
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  await null;

  // Only a and c are in the supplied stream, so b is never searched even though
  // it matches — grep searches the file set it is handed, nothing more.
  const records = await collect(
    E(mount).streamGrep('needle', readerOfPaths(['a.txt', 'c.txt'])),
  );
  t.deepEqual(
    records.map(r => /** @type {any} */ (r).file).sort(),
    ['a.txt', 'c.txt'],
    'exactly the supplied files were grepped, b.txt excluded',
  );
});

// --- Authority: a hand-supplied file stream cannot widen authority ---
// Confinement, denial, directory, and unreadable paths are re-checked in the
// engine per supplied path, so a denied / nonexistent / escaping path in a
// hand-built stream is skipped silently — the same uniform envelope eager
// grep(pattern, paths) guarantees. A caller cannot reach a secret by naming it.

test('a hand-supplied file stream naming denied / missing / directory paths is skipped silently', async t => {
  const root = makeTemporaryRoot(t, 'mount-stream-authority-');
  fs.mkdirSync(path.join(root, '.ssh'));
  fs.writeFileSync(path.join(root, '.ssh', 'id_rsa'), 'must-never-surface\n');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'ok.txt'), 'must-never-surface\n');
  fs.writeFileSync(path.join(root, 'real.txt'), 'must-never-surface\n');
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  await null;

  const records = await collect(
    E(mount).streamGrep(
      'must-never-surface',
      readerOfPaths([
        '.ssh/id_rsa', // denied segment — skipped
        'sub', // a directory — skipped
        'does-not-exist.txt', // unreadable / missing — skipped
        '../escape.txt', // escapes confinement — skipped
        'real.txt', // the one legitimate file
      ]),
    ),
  );
  t.deepEqual(
    records.map(r => /** @type {any} */ (r).file),
    ['real.txt'],
    'only the confined, readable, non-denied file surfaced',
  );
});

test('streamGlob on a subView is scoped to the sub-root, like glob', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  const subView = await E(mount).subView('src');
  const eager = [...(await E(subView).glob('**'))];
  const streamed = await collect(E(subView).streamGlob('**'));
  t.true(streamed.every(filePath => !filePath.startsWith('..')));
  t.deepEqual(streamed, eager);
});

// --- Incrementality: grep reads only as far as the consumer pulls ---

test('streamGrep is incremental: closing after one match leaves later files unread', async t => {
  const root = makeTemporaryRoot(t, 'mount-stream-incremental-');
  const total = 40;
  for (let i = 0; i < total; i += 1) {
    // Every file matches, so the first supplied file to be read produces the
    // first match. grep reads the supplied files one at a time, so far fewer
    // than the whole set is read before the first pull returns.
    fs.writeFileSync(
      path.join(root, `f${String(i).padStart(3, '0')}.txt`),
      'needle here\n',
    );
  }
  const { powers, counters } = makeCountingPowers();
  const mount = makeMount({
    rootPath: root,
    readOnly: false,
    filePowers: powers,
  });

  const iterator = iterateReader(
    E(mount).streamGrep('needle', E(mount).streamGlob('**')),
  );
  const first = await iterator.next();
  t.false(first.done, 'the stream produced a first match');
  t.regex(
    /** @type {any} */ (first.value).file,
    /^f\d{3}\.txt$/,
    'the first match is one of the fixture files',
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

// --- The directory walk is the producer's, and streamGlob's is eager ---
// With grep decoupled, "walk incrementality" is no longer a property of grep. A
// streamGlob('**') producer keeps glob's global sort, so it walks the whole tree
// (reading every subdirectory) before yielding its first path — content reads
// stay incremental in grep, but the *walk* is eager. This pins the current
// composed behavior; restoring a first-match-before-full-walk would need an
// unsorted producer (a flagged follow-up), not a change to grep.

test('streamGrep(p, streamGlob("**")) inherits streamGlob\'s eager walk; grep content reads stay incremental', async t => {
  const root = makeTemporaryRoot(t, 'mount-stream-producer-walk-');
  // Many sibling subdirectories, each holding one matching file.
  const dirs = 40;
  for (let i = 0; i < dirs; i += 1) {
    const sub = path.join(root, `d${String(i).padStart(3, '0')}`);
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'hit.txt'), 'needle here\n');
  }
  const { powers, counters } = makeCountingPowers();
  const mount = makeMount({
    rootPath: root,
    readOnly: false,
    filePowers: powers,
  });

  const iterator = iterateReader(
    E(mount).streamGrep('needle', E(mount).streamGlob('**')),
  );
  const first = await iterator.next();
  t.false(first.done, 'a first match arrives');
  t.regex(
    /** @type {any} */ (first.value).file,
    /^d\d{3}\/hit\.txt$/,
    'the first match is one of the per-directory files',
  );
  // The producer's global sort walked every subdirectory before its first path,
  // so the whole tree is enumerated by the first match — the walk is eager.
  t.true(
    counters.readDirectory > dirs,
    `the streamGlob producer walked the whole tree (${counters.readDirectory} directory reads) before the first match`,
  );
  // But grep read only the one file it needed for the first match — content
  // reads are incremental even though the producer's walk is eager.
  t.is(
    counters.readFileText,
    1,
    'only the first match file was read; grep content reads are incremental',
  );

  // Early close abandons the remaining content reads (the producer's walk is
  // already done).
  await iterator.return();
  await null;
  await null;
  t.is(
    counters.readFileText,
    1,
    'no further files are read after the consumer closes the stream',
  );
});

// --- Backpressure: buffer 0 reads exactly one file per pull, none ahead ---

test('streamGrep with buffer 0 does not read ahead of demand', async t => {
  const root = makeTemporaryRoot(t, 'mount-stream-backpressure-');
  const total = 20;
  for (let i = 0; i < total; i += 1) {
    fs.writeFileSync(
      path.join(root, `f${String(i).padStart(3, '0')}.txt`),
      'hit\n',
    );
  }
  const { powers, counters } = makeCountingPowers();
  const mount = makeMount({
    rootPath: root,
    readOnly: false,
    filePowers: powers,
  });

  const iterator = iterateReader(
    E(mount).streamGrep('hit', E(mount).streamGlob('**')),
  );
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

// --- Cancellation: break out of for-await; content reads stop, no unhandled rejection ---
// What early close abandons is the *content* reads of the still-unread supplied
// files, and it pulls no further paths from the producer.

test('breaking out of a streamGrep for-await leaves the remaining files unread', async t => {
  const root = makeTemporaryRoot(t, 'mount-stream-cancel-');
  const total = 30;
  for (let i = 0; i < total; i += 1) {
    fs.writeFileSync(
      path.join(root, `f${String(i).padStart(3, '0')}.txt`),
      'stop\n',
    );
  }
  const { powers, counters } = makeCountingPowers();
  const mount = makeMount({
    rootPath: root,
    readOnly: false,
    filePowers: powers,
  });

  let seen = 0;
  for await (const match of iterateReader(
    E(mount).streamGrep('stop', E(mount).streamGlob('**')),
  )) {
    t.is(typeof match.file, 'string');
    seen += 1;
    if (seen === 1) {
      break; // triggers iterator.return() -> stops the remaining content reads
    }
  }
  t.is(seen, 1);
  const readsAtBreak = counters.readFileText;
  t.true(readsAtBreak < total, "the break left later files' contents unread");

  // Let any stray continuation settle; ava fails the test on an unhandled
  // rejection, and the read counter must not advance after the break.
  await null;
  await null;
  t.is(counters.readFileText, readsAtBreak, 'no reads after cancellation');
});

// --- Revocation mid-stream: the next pull after revoke() rejects ---

test('streamGrep rejects the next pull after a mid-stream revoke', async t => {
  const root = makeTemporaryRoot(t, 'mount-stream-revoke-');
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    fs.writeFileSync(path.join(root, name), 'live match\n');
  }
  const { mount, control } = makeRevocableMount({
    rootPath: root,
    readOnly: false,
    filePowers,
  });

  const iterator = iterateReader(
    E(mount).streamGrep('match', E(mount).streamGlob('**')),
  );
  const first = await iterator.next();
  t.false(first.done, 'a first match arrives before revocation');

  E(control).revoke();

  await t.throwsAsync(() => iterator.next(), {
    message: /Mount has been revoked/,
  });
});

test('streamGlob throws synchronously at invocation on an already-revoked mount', async t => {
  const root = makeTemporaryRoot(t, 'mount-stream-revoke2-');
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
  // The `files` argument is valid (a real reader), so the rejection is the
  // invocation-time assertLive(), not an argument-guard failure.
  await t.throwsAsync(() => E(mount).streamGrep('x', emptyReader()), {
    message: /Mount has been revoked/,
  });
});

// streamGlob had no mid-stream revoke test: the prover deleted its per-yield
// assertLive() and all tests still passed. Pin that a revoke between pulls cuts
// the stream (the sorted path list is already materialized, so without the
// liveness check the stream would keep yielding paths post-revoke).
test('streamGlob rejects the next pull after a mid-stream revoke', async t => {
  const root = makeTemporaryRoot(t, 'mount-stream-revoke-glob-');
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
    fs.writeFileSync(path.join(root, name), 'x\n');
  }
  const { mount, control } = makeRevocableMount({
    rootPath: root,
    readOnly: false,
    filePowers,
  });

  const iterator = iterateReader(E(mount).streamGlob('**'));
  const first = await iterator.next();
  t.false(first.done, 'a first path arrives before revocation');

  await E(control).revoke();

  await t.throwsAsync(() => iterator.next(), {
    message: /Mount has been revoked/,
  });
});

// A sparse streamGrep (one match up front, then many non-matching files) must
// observe a mid-stream revoke rather than reading every remaining file to the
// end of the walk. Without the per-path-batch liveness check the per-yield
// assertLive() never fires again (no further match), so the daemon would drain
// the whole tree and the stream would end { done: true }, never observing the
// revoke (assessor finding: 199 further readFileText calls, consumer saw done).
test('a sparse streamGrep observes a mid-stream revoke without reading to the end of the walk', async t => {
  const root = makeTemporaryRoot(t, 'mount-stream-sparse-revoke-');
  const total = 200;
  for (let i = 0; i < total; i += 1) {
    // Only `f000.txt` matches, so it is the single (hence first) match whatever
    // the walk order; after that first pull no further yield ever occurs, which
    // is what makes the per-yield assertLive() insufficient on its own.
    fs.writeFileSync(
      path.join(root, `f${String(i).padStart(3, '0')}.txt`),
      i === 0 ? 'needle here\n' : 'no match on this line\n',
    );
  }
  const { powers, counters } = makeCountingPowers();
  const { mount, control } = makeRevocableMount({
    rootPath: root,
    readOnly: false,
    filePowers: powers,
  });

  const iterator = iterateReader(
    E(mount).streamGrep('needle', E(mount).streamGlob('**')),
  );
  const first = await iterator.next();
  t.false(first.done, 'the single match arrives before revocation');
  t.is(/** @type {any} */ (first.value).file, 'f000.txt');

  const readsAtRevoke = counters.readFileText;
  await E(control).revoke();

  // The next pull rejects — the stream never ends clean past a revoke.
  await t.throwsAsync(() => iterator.next(), {
    message: /Mount has been revoked/,
  });
  // And the revoke was observed within one file, not after draining the whole
  // supplied stream of non-matching files.
  t.true(
    counters.readFileText <= readsAtRevoke + 2,
    `post-revoke reads are bounded to one file: ${
      counters.readFileText - readsAtRevoke
    } more after revoke, of ${total - 1} remaining files`,
  );
});

// --- Confinement and denial parity: secrets and escapes never surface ---

test('streamGlob never yields denied names or entries escaping the mount', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  const paths = await collect(E(mount).streamGlob('**'));
  const segments = paths.flatMap(filePath => filePath.split('/'));
  for (const denied of ['.ssh', '.aws', '.env', '.SSH', '.gnupg']) {
    t.false(
      segments.includes(denied),
      `${denied} must never appear in the stream`,
    );
  }
  t.false(
    paths.some(filePath => filePath.includes('escape-target')),
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
    await collect(
      E(mount).streamGrep('must-never-surface', E(mount).streamGlob('**')),
    ),
    [],
    'denied files are never searched',
  );
  // The escaping symlink target (outside confinement) carries this text.
  t.deepEqual(
    await collect(
      E(mount).streamGrep('outside the mount', E(mount).streamGlob('**')),
    ),
    [],
    'a symlink escaping the mount root is never followed',
  );
});

// --- Pattern guard: the reader self-describes its element shape ---

test('streamGlob readPattern is a no-limit M.string() and every element matches it', async t => {
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
  const reader = E(mount).streamGrep(
    'export',
    E(mount).streamGlob('src/**/*.js'),
  );
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

// --- Long lines: the readPattern must not cap match length below eager grep ---
// The reader pump enforces readPattern with mustMatch on every element; a bare
// M.string() caps at 100,000 chars and a throw there aborts the whole stream.
// Eager grep has no such cap, so an over-limit match line is a stream-only
// parity break unless the readPattern carries an explicit large stringLengthLimit.

test('streamGrep streams a match line longer than the default string-length limit', async t => {
  const root = makeTemporaryRoot(t, 'mount-stream-long-line-');
  const atLimit = 'a'.repeat(100_000); // exactly the default M.string() limit
  const overLimit = 'b'.repeat(100_001); // one past it — the regression boundary
  // ok / big / ok: a short match, then the over-limit match, then two more short
  // matches. Under a bare M.string() the over-limit element throws in the pump
  // and every later match is lost; all four must arrive here, in order.
  const source = [
    'needle short-one',
    `needle ${overLimit}`,
    `needle ${atLimit}`,
    'needle short-two',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'big.txt'), `${source}\n`);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  await null;

  const records = await collect(
    E(mount).streamGrep('needle', E(mount).streamGlob('**')),
  );
  t.is(records.length, 4, 'every matching line streams, long lines included');
  const longText = /** @type {string} */ (records[1].text);
  t.true(
    longText.length > 100_000,
    'the over-limit fixture line is genuinely past the default limit',
  );
  t.is(
    longText,
    `needle ${overLimit}`,
    'the > 100,000-char match line streams whole, untruncated',
  );

  // Parity with eager grep on the same fixture: same count, same text.
  const eager = await E(mount).grep('needle');
  t.is(
    records.length,
    eager.length,
    'stream and eager grep agree on match count',
  );
  t.deepEqual(
    records.map(record => /** @type {any} */ (record).text),
    eager.map(match => match.text),
    'stream and eager grep agree on match text, the long line included',
  );
});

test('streamGrep streams a match line past 10 MB — no residual finite ceiling', async t => {
  // A prior revision capped the readPattern at 10,000,000 chars, so a single
  // line past it aborted the whole stream (dropping every later match), a
  // parity break eager grep does not share. The pattern now opts out of any
  // finite stringLengthLimit, so even a > 10 MB line streams whole and the
  // matches after it survive. [purist / spec-keeper / wire-watcher findings]
  t.timeout(120_000);
  const root = makeTemporaryRoot(t, 'mount-stream-huge-line-');
  const hugeLine = 'z'.repeat(10_000_001); // one past the old 10 MB ceiling
  const source = ['needle before', `needle ${hugeLine}`, 'needle after'].join(
    '\n',
  );
  fs.writeFileSync(path.join(root, 'huge.txt'), `${source}\n`);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  await null;

  const records = await collect(
    E(mount).streamGrep('needle', E(mount).streamGlob('**')),
  );
  t.is(records.length, 3, 'the match after a > 10 MB line is not lost');
  t.true(
    /** @type {string} */ (records[1].text).length > 10_000_000,
    'the > 10 MB match line streams whole, untruncated',
  );
  t.is(
    /** @type {any} */ (records[2].text),
    'needle after',
    'later matches survive the over-10-MB line (no stream-fatal abort)',
  );
});

// --- Once-only: a search reader latches to a single active stream ---
// readerFromIterator({ once: true }) rejects a second stream() rather than
// starting a second walk over the shared iterator (which would split the
// element set and open a second pre-ack window). The mount's search readers are
// minted this way, so a grantee cannot open k concurrent streams to scale the
// pre-ack / post-revoke window as k×buffer. [warden finding 1]

test('readerFromIterator({ once: true }) rejects a second stream()', async t => {
  const reader = readerFromIterator(
    (async function* g() {
      yield 'a';
      yield 'b';
    })(),
    { readPattern: M.string(), once: true },
  );
  const collected = await collect(reader);
  t.deepEqual(collected, ['a', 'b'], 'the first stream drains normally');
  await t.throwsAsync(() => collect(reader), {
    message: /once-only/,
  });
});

test('a mount search reader is once-only: a second consumer rejects', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  await null;
  const reader = E(mount).streamGlob('**');
  const first = await collect(reader);
  t.true(first.length > 0, 'the first stream drains normally');
  await t.throwsAsync(() => collect(reader), {
    message: /once-only/,
  });
});

// --- Record correspondence: { line, text } identifies the matched source line ---

test('streamGrep { line, text } identifies the matched source line for generated content', async t => {
  // The readPattern guard above pins record *shape* only; it never checks that
  // `line`/`text` actually point at the source line the record claims. This is
  // the contract the method's doc comment states ("{ file, line, text } records
  // identify one matched line"), so pin it directly — and against *generated*
  // content matched by a non-literal regex, where `text` must be the whole
  // source line, not merely the matched substring.
  const root = makeTemporaryRoot(t, 'mount-grep-correspondence-');
  // Generate a multi-line file whose matches are produced by a regex, not a
  // literal: a `MARK-<n>` token on a subset of lines, interleaved with lines
  // that must never match. A blank line and a two-match line stress the
  // whole-line (not substring) and one-record-per-line invariants.
  /** @type {string[]} */
  const lines = [];
  for (let i = 0; i < 40; i += 1) {
    if (i % 7 === 0) {
      lines.push(`  const value${i} = compute(); // MARK-${i} keep this line`);
    } else if (i % 5 === 0) {
      lines.push(''); // blank line, never matches
    } else {
      lines.push(`  noise line ${i} without the token`);
    }
  }
  // A line bearing the token twice: still one record, still the whole line.
  lines.push('MARK-100 and again MARK-101 on one line');
  const source = lines.join('\n');
  fs.writeFileSync(path.join(root, 'generated.js'), source);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  await null;

  const records = await collect(
    E(mount).streamGrep('MARK-\\d+', E(mount).streamGlob('**')),
  );
  t.true(records.length > 3, 'the regex matches several generated lines');

  // Source of truth: re-read the file from disk and split on newlines exactly
  // as the grep engine reports 1-based line numbers.
  const onDisk = fs.readFileSync(path.join(root, 'generated.js'), 'utf8');
  const sourceLines = onDisk.split('\n');
  const seenLines = new Set();
  for (const record of records) {
    const file = /** @type {string} */ (record.file);
    const line = /** @type {number} */ (record.line);
    const text = /** @type {string} */ (record.text);
    t.is(file, 'generated.js', 'every record names the searched file');
    t.is(typeof line, 'number');
    t.true(line >= 1 && line <= sourceLines.length, 'line is in range');
    t.false(seenLines.has(line), 'at most one record per matched line');
    seenLines.add(line);
    // The load-bearing invariant: `text` is the whole matched source line,
    // and `line` is the 1-based index that recovers it.
    t.is(text, sourceLines[line - 1], `text === source line ${line}`);
    t.false(text.includes('\n'), 'text carries no embedded newline');
    t.regex(
      text,
      /MARK-\d+/,
      'the reported line genuinely matches the pattern',
    );
  }
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
  await t.throwsAsync(() => E(view).streamGrep('x', emptyReader()), {
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
  const root = makeTemporaryRoot(t, 'mount-stream-grepcap-');
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

  const streamed = await collect(
    E(mount).streamGrep('needle', E(mount).streamGlob('**')),
  );
  t.is(
    streamed.length,
    overCap,
    'streamGrep yields every match, past the eager cap',
  );
  t.true(streamed.length > eager.length);
});

test('streamGlob yields past GLOB_MAX_RESULTS while glob truncates at it', async t => {
  t.timeout(120_000);
  const root = makeTemporaryRoot(t, 'mount-stream-globcap-');
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
  const root = makeTemporaryRoot(t, 'mount-stream-clamp-');
  // More one-match files than the ceiling, so "clamped to 1024" is observably
  // distinct from "reads them all". One matching line per file => one element
  // (and one readFileText) per file.
  const total = STREAM_BUFFER_MAX + 100;
  for (let i = 0; i < total; i += 1) {
    fs.writeFileSync(
      path.join(root, `f${String(i).padStart(5, '0')}.txt`),
      'needle\n',
    );
  }
  const { powers, counters } = makeCountingPowers();
  const mount = makeMount({
    rootPath: root,
    readOnly: false,
    filePowers: powers,
  });
  await null;

  // Request a buffer far above the ceiling and DON'T pull: the producer pre-acks
  // up to its clamped buffer, then blocks awaiting a synchronize node.
  const iterator = iterateReader(
    E(mount).streamGrep('needle', E(mount).streamGlob('**'), {
      buffer: STREAM_BUFFER_MAX * 4,
    }),
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
  const root = makeTemporaryRoot(t, 'mount-stream-revoke-buffer-');
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
  const iterator = iterateReader(
    E(mount).streamGrep('match', E(mount).streamGlob('**'), { buffer }),
  );
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
    t.regex(/** @type {Error} */ (error).message, /Mount has been revoked/);
  }

  t.true(rejected, 'the stream rejects once the pre-acked buffer drains');
  t.true(
    delivered <= clampStreamBuffer(buffer),
    `at most the clamped buffer (${clampStreamBuffer(
      buffer,
    )}) elements arrive after revoke; got ${delivered}`,
  );
});

// --- Content reads stay incremental across a deep composed pipeline ---
// With grep decoupled, the directory walk belongs to the producer (an eager
// streamGlob('**') here). What grep guarantees is that it reads the supplied
// files' *contents* one at a time: on a deep tree with two matching files, only
// the first match's file is read before the first pull returns, and early close
// leaves the other unread. (The producer's walk is eager; that is pinned by the
// producer-walk test above.)

test('streamGrep content reads stay incremental on a deep composed pipeline', async t => {
  const root = makeTemporaryRoot(t, 'mount-stream-deep-');
  // Branch A: a shallow match. Branch B: a deep chain whose deepest file also
  // matches. Two matching files, so early close after the first can leave the
  // second unread.
  const branchA = path.join(root, 'branch-a');
  fs.mkdirSync(branchA);
  fs.writeFileSync(path.join(branchA, 'shallow.txt'), 'deep-needle\n');
  let directory = path.join(root, 'branch-b');
  fs.mkdirSync(directory);
  const depth = 10;
  for (let i = 0; i < depth; i += 1) {
    directory = path.join(directory, `d${i}`);
    fs.mkdirSync(directory);
  }
  fs.writeFileSync(path.join(directory, 'deep.txt'), 'deep-needle\n');

  const { powers, counters } = makeCountingPowers();
  const mount = makeMount({
    rootPath: root,
    readOnly: false,
    filePowers: powers,
  });
  const iterator = iterateReader(
    E(mount).streamGrep('deep-needle', E(mount).streamGlob('**')),
  );
  const firstMatch = await iterator.next();
  t.false(firstMatch.done);
  t.regex(
    /** @type {any} */ (firstMatch.value).file,
    /^branch-(a\/shallow\.txt|b\/(d\d\/)+deep\.txt)$/,
    'the first match is one of the two matching files',
  );

  // Content reads are incremental: only the one match file was read for the
  // first pull, even though the producer's walk has already run.
  t.is(counters.readFileText, 1, 'only the first match file was read');

  await iterator.return();
  await null;
  await null;
  t.is(counters.readFileText, 1, 'early close leaves the other file unread');
});

// --- streamGlob early cancellation: return() cleans up before completion ---
// [corner-prober finding 5: streamGlob had zero cancellation coverage]

test('breaking out of a streamGlob for-await stops cleanly with no late reads', async t => {
  const { root } = buildMountFixture(t);
  const { powers, counters } = makeCountingPowers();
  const mount = makeMount({
    rootPath: root,
    readOnly: false,
    filePowers: powers,
  });

  let seen = 0;
  for await (const filePath of iterateReader(E(mount).streamGlob('**'))) {
    t.is(typeof filePath, 'string');
    seen += 1;
    if (seen === 1) {
      break; // triggers iterator.return()
    }
  }
  t.is(seen, 1);
  const directoryReadsAtBreak = counters.readDirectory;
  await null;
  await null;
  t.is(
    counters.readDirectory,
    directoryReadsAtBreak,
    'no directory reads after cancellation',
  );
});

// --- streamGrep over a producer matching zero files yields nothing ---
// [corner-prober finding 6]

test('streamGrep over a streamGlob that matches no file yields an empty stream', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  await null;
  t.deepEqual(
    await collect(
      E(mount).streamGrep(
        'export',
        E(mount).streamGlob('no-such-dir/**/*.nope'),
      ),
    ),
    [],
    'a producer matching nothing produces no matches',
  );
});
