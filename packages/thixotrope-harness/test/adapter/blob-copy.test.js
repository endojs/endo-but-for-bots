// @ts-check
// The blob store's relay copy (resources/agent-host/impl/blobs.js `copy`
// and the `RelayWriters` exo; designs/m9-interfaces.md D-M9-4, 3.3, seam
// A1, acceptance 19 and 20, kill point KM12). Node, real files in a
// temporary directory; the kill test runs `_blob-copy-kill-child.mjs`.
import '../unit/_m1a-prelude.js';

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { execPath } from 'node:process';
import { fileURLToPath } from 'node:url';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { shapes, textOf, texts } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { postOfficeMethodNames } from '../../guest/lib/guards/post-office.js';
/* eslint-enable import/no-relative-packages */
import { makeBlobStore } from '../../resources/agent-host/impl/blobs.js';
import {
  filesIn,
  makeFakeBlobSink,
  makeTestBlobs,
  partsIn,
} from './_m1b-blobs.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, matches } = /** @type {GuestGlobals} */ (globalThis);

const harnessRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CHILD = fileURLToPath(
  new URL('./_blob-copy-kill-child.mjs', import.meta.url),
);

/**
 * An exo's interface name.
 * @param {any} exo
 */
const tagOf = exo => exo[Symbol.toStringTag];

/** Three fake sessions (owners): B the sender, A the recipient, C a third. */
const sessions = () => ({
  a: Far('Session', {}),
  b: Far('Session', {}),
  c: Far('Session', {}),
});

/**
 * A text with characters of 1, 2, 3 and 4 bytes (5 units a repeat).
 * @param {number} repeat
 */
const mixed = repeat => `aé中\u{1F600}`.repeat(repeat);

test('copy: a hard link under a fresh handle, linked, named and the directory fsynced before it is bound', async t => {
  /** @type {string[]} */
  const steps = [];
  const blobs = makeTestBlobs({
    trace: (step, key) => steps.push(`${step}:${key}`),
  });
  t.teardown(blobs.cleanup);
  const { a, b } = sessions();
  const text = mixed(3000);
  const source = await blobs.store.stage(text, { owner: b });
  steps.length = 0;
  const copied = await blobs.store.copy(source.blob, {});
  t.true(matches(copied, shapes.StagedText));
  t.not(copied.blob, source.blob);
  const key = /** @type {string} */ (blobs.store.keyOf(copied.blob));
  t.deepEqual(steps, [
    `link:${key}`,
    `rename:${key}`,
    `fsync-dir:${key}`,
    `bind:${key}`,
  ]);
  // Acceptance 19: the same inode; digest, bytes and preview of the source.
  const sourceKey = /** @type {string} */ (blobs.store.keyOf(source.blob));
  t.is(
    statSync(join(blobs.blobDir, key)).ino,
    statSync(join(blobs.blobDir, sourceKey)).ino,
  );
  t.is(copied.bytes, source.bytes);
  t.is(copied.digest, source.digest);
  t.is(copied.preview, source.preview);
  t.deepEqual(partsIn(blobs.blobDir), []);
  t.like(blobs.store.stats(), { linked: 1, copiedBytes: source.bytes });
  // Charged to the daemon only, not to the sender.
  t.deepEqual(blobs.store.usage(b), {
    session: source.bytes,
    daemon: 2 * source.bytes,
  });
  t.is(blobs.store.usage(a).session, 0);
  t.is(await blobs.store.read(copied.blob, a), text);
  t.is(blobs.store.usage(a).session, source.bytes);
});

test("copy: readable by its first owner, refused to a third; the source stays the sender's", async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const { a, b, c } = sessions();
  const text = 'x'.repeat(limits.inlineBytes + 1);
  const source = await blobs.store.stage(text, { owner: b });
  const copied = await blobs.store.copy(source.blob, {});
  const page = await blobs.store.readPage(copied.blob, 0, 100, a);
  t.is(page.text, 'x'.repeat(100));
  await t.throwsAsync(() => blobs.store.read(copied.blob, c), {
    message: texts.blobNotOwned,
  });
  t.is(await blobs.store.read(source.blob, b), text);
  await t.throwsAsync(() => blobs.store.read(source.blob, a), {
    message: texts.blobNotOwned,
  });
  // A copy is made fresh per recipient.
  const second = await blobs.store.copy(source.blob, {});
  t.not(second.blob, copied.blob);
  t.is(await blobs.store.read(second.blob, c), text);
});

test("copy: the copy survives the source session's delete (acceptance 19)", async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const { a, b } = sessions();
  const text = mixed(2500);
  const source = await blobs.store.stage(text, { owner: b });
  const copied = await blobs.store.copy(source.blob, {});
  const sourceKey = /** @type {string} */ (blobs.store.keyOf(source.blob));
  t.is(await blobs.store.release([sourceKey]), 1);
  t.is(await blobs.store.read(copied.blob, a), text);
  t.is(
    statSync(
      join(
        blobs.blobDir,
        /** @type {string} */ (blobs.store.keyOf(copied.blob)),
      ),
    ).nlink,
    1,
  );
});

test('copy with maxUnits: a streamed copy cut with the R4-46 marker, then the suffix', async t => {
  /** @type {string[]} */
  const steps = [];
  const blobs = makeTestBlobs({ trace: step => steps.push(step) });
  t.teardown(blobs.cleanup);
  const { a, b } = sessions();
  const maxUnits = limits.toolOutputUnits - 1280;
  // 100,000 units whose code points straddle every read boundary.
  const text = mixed(20_000);
  t.is(text.length, 100_000);
  const suffix = '\n[2 attachments]';
  const source = await blobs.store.stage(text, { owner: b });
  steps.length = 0;
  const cut = await blobs.store.copy(source.blob, { maxUnits, suffix });
  t.true(matches(cut, shapes.StagedText));
  t.deepEqual(steps, ['fsync', 'rename', 'fsync-dir', 'bind']);
  const written = await blobs.store.read(cut.blob, a);
  const marker = textOf.truncationMarker(text.length);
  t.true(written.endsWith(`${marker}${suffix}`));
  t.true(written.length <= maxUnits + suffix.length);
  t.true(
    written.length >= maxUnits + suffix.length - 1,
    'a pair is kept whole',
  );
  t.true(
    text.startsWith(
      written.slice(0, written.length - marker.length - suffix.length),
    ),
  );
  t.is(cut.bytes, Buffer.byteLength(written, 'utf8'));
  t.not(
    statSync(
      join(blobs.blobDir, /** @type {string} */ (blobs.store.keyOf(cut.blob))),
    ).ino,
    statSync(
      join(
        blobs.blobDir,
        /** @type {string} */ (blobs.store.keyOf(source.blob)),
      ),
    ).ino,
  );
  t.like(blobs.store.stats(), { cutCopies: 1, linked: 0 });
  t.is(blobs.store.usage(b).session, source.bytes, 'not charged to the sender');

  // Within maxUnits: the whole text and the suffix, no marker.
  const short = await blobs.store.copy(source.blob, {
    maxUnits: 200_000,
    suffix,
  });
  t.is(await blobs.store.read(short.blob, a), `${text}${suffix}`);
  // A suffix alone: the whole text streamed, then the suffix.
  const suffixed = await blobs.store.copy(source.blob, { suffix });
  t.is(await blobs.store.read(suffixed.blob, a), `${text}${suffix}`);
  // A limit shorter than the marker cuts the marker.
  const tiny = await blobs.store.copy(source.blob, { maxUnits: 20 });
  t.is(await blobs.store.read(tiny.blob, a), marker.slice(0, 20));
});

test('copy refuses a handle it cannot resolve, and one whose file was discarded', async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  await t.throwsAsync(() => blobs.store.copy(Far('Blob', {}), {}), {
    message: texts.blobUnknown,
  });
  const staged = await blobs.store.stage('d'.repeat(9000));
  t.true(await blobs.store.discard(staged.blob));
  await t.throwsAsync(() => blobs.store.copy(staged.blob, {}), {
    message: texts.blobUnknown,
  });
  // A handle written but not committed never left the process: unknown.
  const pending = await blobs.store.stagePending('p'.repeat(9000));
  await t.throwsAsync(() => blobs.store.copy(pending.blob, { maxUnits: 5 }), {
    message: texts.blobUnknown,
  });
  t.deepEqual(filesIn(blobs.blobDir), []);
});

test('copy counts against the daemon quota and leaves nothing when refused or failed', async t => {
  let failAt = '';
  const fake = makeFakeBlobSink();
  mkdirSync(join(harnessRoot, 'tmp'), { recursive: true });
  const root = mkdtempSync(join(harnessRoot, 'tmp', 'blob-copy-'));
  t.teardown(() => rmSync(root, { recursive: true, force: true }));
  const blobDir = join(root, 'blobs');
  const store = makeBlobStore({
    dir: blobDir,
    sink: fake.sink,
    quota: { sessionBytes: 1_000_000, daemonBytes: 25_000 },
    trace: step => {
      if (step === failAt) throw Error('disk gone');
    },
  });
  const source = await store.stage('q'.repeat(10_000));
  await store.copy(source.blob, {});
  t.is(store.usage(undefined).daemon, 20_000);
  await t.throwsAsync(() => store.copy(source.blob, {}), {
    message: textOf.blobDaemonQuota(10_000, 20_000, 25_000),
  });
  await t.throwsAsync(() => store.copy(source.blob, { maxUnits: 9000 }), {
    message: /daemon/,
  });
  t.is(store.usage(undefined).daemon, 20_000);
  t.is(filesIn(blobDir).length, 2);
  t.deepEqual(partsIn(blobDir), []);

  // A failed step: refunded, no file, no handle answered.
  const small = await store.stage('s'.repeat(1000));
  for (const step of ['link', 'rename', 'fsync-dir']) {
    failAt = step;
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => store.copy(small.blob, {}), {
      message: 'disk gone',
    });
  }
  failAt = 'fsync-dir';
  await t.throwsAsync(() => store.copy(small.blob, { suffix: '!' }), {
    message: 'disk gone',
  });
  failAt = '';
  t.is(store.usage(undefined).daemon, 21_000);
  t.is(filesIn(blobDir).length, 3);
  t.deepEqual(partsIn(blobDir), []);
});

test("writersFor(): the relay writers (open, copy) through their guard; a session's writers have no copy", async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const { a, b } = sessions();
  const relay = blobs.store.writersFor(undefined);
  t.is(blobs.store.writersFor(undefined), relay, 'one relay exo');
  t.is(tagOf(relay), 'Alleged: RelayWriters');
  t.deepEqual([...postOfficeMethodNames.RelayWriters], ['open', 'copy']);
  const own = blobs.store.writersFor(b);
  t.is(tagOf(own), 'Alleged: BlobWriters');
  t.is(/** @type {any} */ (own).copy, undefined);
  t.is(tagOf(blobs.store.writers), 'Alleged: BlobWriters');

  const source = await blobs.store.stage('r'.repeat(9000), { owner: b });
  const copied = await E(relay).copy(source.blob, {});
  t.is(await blobs.store.read(copied.blob, a), 'r'.repeat(9000));
  const cut = await E(relay).copy(source.blob, { maxUnits: 300 });
  t.is((await blobs.store.read(cut.blob, a)).length, 300);
  // The guard: closed options, a Blob remotable.
  await t.throwsAsync(() => E(relay).copy(source.blob, { units: 3 }));
  await t.throwsAsync(() => E(relay).copy('b1', {}));
  // `open` is an ownerless writer, as before (the factory's prompts).
  const writer = await E(relay).open();
  await E(writer).append('prompt');
  const staged = await E(writer).close();
  t.is(await blobs.store.read(staged.blob, a), 'prompt');
});

/**
 * @param {string} blobDir
 * @param {'plain' | 'cut'} mode
 * @param {string} killAt
 */
const runChild = async (blobDir, mode, killAt) => {
  const child = spawn(execPath, [CHILD, blobDir, mode, killAt], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', chunk => {
    out += chunk;
  });
  child.stderr.on('data', chunk => {
    err += chunk;
  });
  const [code, signal] = await once(child, 'exit');
  const lines = out
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line));
  return {
    code,
    signal,
    err,
    source: lines.find(line => line.source)?.source,
    copy: lines.find(line => line.copy)?.copy,
  };
};

/** What a kill at each step of a copy leaves: a part file, a named file. */
const KILLS = harden({
  plain: {
    link: { part: false, named: false },
    rename: { part: true, named: false },
    'fsync-dir': { part: false, named: true },
    bind: { part: false, named: true },
    after: { part: false, named: true },
  },
  cut: {
    fsync: { part: true, named: false },
    rename: { part: true, named: false },
    'fsync-dir': { part: false, named: true },
    bind: { part: false, named: true },
    after: { part: false, named: true },
  },
});

test('KM12: SIGKILL at every step of a copy leaves the source whole and at most one file nothing names', async t => {
  mkdirSync(join(harnessRoot, 'tmp'), { recursive: true });
  const dir = mkdtempSync(join(harnessRoot, 'tmp', 'blob-copy-kill-'));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  const text = 'relay '.repeat(4000);
  for (const [mode, kills] of Object.entries(KILLS)) {
    for (const [killAt, expected] of Object.entries(kills)) {
      const blobDir = join(dir, `${mode}-${killAt}`);
      // eslint-disable-next-line no-await-in-loop
      const run = await runChild(
        blobDir,
        /** @type {'plain' | 'cut'} */ (mode),
        killAt,
      );
      const label = `${mode} ${killAt}`;
      t.is(run.signal, 'SIGKILL', `${label}: ${run.err.slice(0, 300)}`);
      t.is(typeof run.source, 'string', label);
      t.is(partsIn(blobDir).length, expected.part ? 1 : 0, label);
      const named = filesIn(blobDir).sort();
      t.deepEqual(
        named,
        expected.named ? [run.source, run.copy].sort() : [run.source],
        label,
      );
      // The next incarnation: its sweep removes the part file and counts
      // what is named; the source reads whole (no handle any vat holds
      // lost its file: the copy's handle never left the child).
      const next = makeBlobStore({
        dir: blobDir,
        sink: makeFakeBlobSink().sink,
      });
      // eslint-disable-next-line no-await-in-loop
      await next.sweep();
      t.deepEqual(partsIn(blobDir), [], label);
      t.deepEqual(filesIn(blobDir).sort(), named, label);
      // eslint-disable-next-line no-await-in-loop
      t.is(await next.readKey(run.source), text, label);
      t.is(readFileSync(join(blobDir, run.source), 'utf8'), text, label);
      if (expected.named && mode === 'plain') {
        t.is(
          statSync(join(blobDir, run.copy)).ino,
          statSync(join(blobDir, run.source)).ino,
          label,
        );
      }
      if (expected.named && mode === 'cut') {
        // eslint-disable-next-line no-await-in-loop
        const cut = await next.readKey(run.copy);
        t.true(cut.endsWith('\n[note]'), label);
        t.true(cut.length <= 10_000 + '\n[note]'.length, label);
      }
    }
  }
});
