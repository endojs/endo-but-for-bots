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
