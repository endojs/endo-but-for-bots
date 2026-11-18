// @ts-check
// M1b follow-ups (JOURNAL J-9360..J-9379; designs/m1b-interfaces.md 17):
// blob digests, disk quotas, files of refused or never-sent stagings,
// blob provenance between sessions, and the context cache's per-prepare
// timing and oversize eviction. Node, real files, fake sessions.
import '../unit/_m1a-prelude.js';

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { shapes, textOf, texts } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { HUB_RETIRED_MESSAGE } from '../../guest/lib/retired.js';
import { makeRecordLog } from '../../guest/session/records.js';
import { makeContextSource } from '../../guest/session/context-source.js';
/* eslint-enable import/no-relative-packages */
import { blobLimits } from '../../config/defaults.js';
import { make as makeManagerVat } from '../../resources/agent-host/durable.js';
import { makeComposer } from '../../resources/agent-host/impl/composer.js';
import { makeContextCache } from '../../resources/agent-host/impl/context-cache.js';
import { makeAgentHostImpl } from '../../resources/agent-host/impl/index.js';
import { makeTimers } from '../../resources/agent-host/impl/timers.js';
import { makeBlobStore } from '../../resources/agent-host/impl/blobs.js';
import {
  blobsUntil as until,
  filesIn,
  makeFakeBlobSink,
  makeFakeSession,
  makeTestBlobs,
  partsIn,
  runRoundFor as runRound,
} from './_m1b-blobs.js';
import { makeSessionSim } from './_m1b-context.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, matches } = /** @type {GuestGlobals} */ (globalThis);

const timers = makeTimers();
const requestId = `${Date.now()}-fixed-request-id`;

/** @param {string} text */
const sha256 = text =>
  createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

// ---------------------------------------------------------------- digest

test('J-9363: every StagedText carries the SHA-256 of its UTF-8 bytes', async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const text = `${'é'.repeat(5000)}\u{1F600}`;
  const staged = await blobs.store.stage(text);
  t.is(staged.digest, sha256(text));
  t.true(matches(staged, shapes.StagedText));
  const pending = await blobs.store.stagePending(`${text}x`);
  t.is(pending.digest, sha256(`${text}x`));
  const writer = await E(blobs.store.writers).open();
  await E(writer).append('a'.repeat(5000));
  await E(writer).append('b'.repeat(5000));
  const written = await E(writer).close();
  t.is(written.digest, sha256(`${'a'.repeat(5000)}${'b'.repeat(5000)}`));
  t.true(matches(written, shapes.StagedText));
});

// ---------------------------------------------------------------- quotas

test('J-9361: the settings exist and are the defaults the store uses', t => {
  t.is(blobLimits.sessionBytes, 1024 * 1024 * 1024);
  t.is(blobLimits.daemonBytes, 16 * 1024 * 1024 * 1024);
  t.true(Object.isFrozen(blobLimits));
});

test('J-9361: a session over its quota is refused with the quota text; nothing is written; other sessions go on', async t => {
  const quota = { sessionBytes: 25_000, daemonBytes: 1_000_000 };
  const blobs = makeTestBlobs({ quota });
  t.teardown(blobs.cleanup);
  const composer = makeComposer({ now: () => 7, blobs: blobs.store });
  const a = makeFakeSession();
  const b = makeFakeSession();
  const text = 'q'.repeat(12_000);
  await E(composer).submit(a.session, text, requestId);
  await E(composer).submit(a.session, text, requestId);
  t.is(filesIn(blobs.blobDir).length, 2);
  await t.throwsAsync(() => E(composer).submit(a.session, text, requestId), {
    message: textOf.stagingFailed(
      textOf.blobSessionQuota(12_000, 24_000, 25_000),
    ),
  });
  t.is(a.seen.length, 2, 'the refused text never reached the session');
  t.is(filesIn(blobs.blobDir).length, 2, 'and nothing was written');
  t.deepEqual(partsIn(blobs.blobDir), []);
  // Another session has its own quota.
  await E(composer).submit(b.session, text, requestId);
  t.is(b.seen.length, 1);
  // A deleted file is refunded.
  t.true(await blobs.store.discard(a.seen[0].blob));
  await E(composer).submit(a.session, text, requestId);
  t.is(a.seen.length, 3);
  t.like(blobs.store.stats(), { refusedSession: 1 });
});

test('J-9361: the daemon quota counts the files already on disk at start and every session', async t => {
  const first = makeTestBlobs();
  t.teardown(first.cleanup);
  const fake = makeFakeBlobSink();
  // 3 files of 10,000 bytes from an earlier incarnation.
  const earlier = makeBlobStore({
    dir: first.blobDir,
    sink: fake.sink,
  });
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await earlier.stage('e'.repeat(10_000));
  }
  const store = makeBlobStore({
    dir: first.blobDir,
    sink: fake.sink,
    quota: { sessionBytes: 1_000_000, daemonBytes: 45_000 },
  });
  await store.sweep();
  t.is(store.usage(undefined).daemon, 30_000);
  const owner = Far('Session', {});
  await store.stage('x'.repeat(10_000), { owner });
  await t.throwsAsync(() => store.stage('y'.repeat(10_000), { owner }), {
    message: textOf.blobDaemonQuota(10_000, 40_000, 45_000),
  });
  t.is(filesIn(first.blobDir).length, 4);
  t.like(store.usage(owner), { session: 10_000, daemon: 40_000 });
});

test('J-9361: a writer is checked piece by piece; an aborted writer is refunded', async t => {
  const blobs = makeTestBlobs({
    quota: { sessionBytes: 30_000, daemonBytes: 1_000_000 },
  });
  t.teardown(blobs.cleanup);
  const owner = Far('Session', {});
  const writers = blobs.store.writersFor(owner);
  const writer = await E(writers).open();
  await E(writer).append('a'.repeat(limits.blobPieceBytes));
  await E(writer).append('a'.repeat(limits.blobPieceBytes));
  await t.throwsAsync(
    () => E(writer).append('a'.repeat(limits.blobPieceBytes)),
    {
      message: textOf.blobSessionQuota(
        limits.blobPieceBytes,
        2 * limits.blobPieceBytes,
        30_000,
      ),
    },
  );
  E.sendOnly(writer).abort();
  await until(() => blobs.store.usage(owner).session === 0);
  t.deepEqual(partsIn(blobs.blobDir), []);
});

// ---------------------------------------------------------------- files nobody holds

test('J-9361: a submission the session refused has its file deleted; a break keeps it', async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const composer = makeComposer({ now: () => 7, blobs: blobs.store });
  const text = 'r'.repeat(limits.inlineBytes + 10);
  const refuser = makeFakeSession(() => {
    throw Error(textOf.queueFull(limits.maxWaiting));
  });
  await t.throwsAsync(
    () => E(composer).submit(refuser.session, text, requestId),
    { message: textOf.queueFull(limits.maxWaiting) },
  );
  await until(() => blobs.store.stats().discarded === 1);
  t.deepEqual(
    filesIn(blobs.blobDir),
    [],
    'the refused submission left no file',
  );
  // A retired break may come after the session kept the handle: kept.
  const broken = makeFakeSession(() => {
    throw Error(HUB_RETIRED_MESSAGE);
  });
  await t.throwsAsync(() =>
    E(composer).submit(broken.session, text, requestId),
  );
  await timers.delay(20);
  t.is(filesIn(blobs.blobDir).length, 1, 'a break keeps the file');
});

test('J-9361: a staging whose handle never left the process is a .part file the next start deletes', async t => {
  const first = makeTestBlobs();
  t.teardown(first.cleanup);
  const fake = makeFakeBlobSink();
  const before = makeBlobStore({ dir: first.blobDir, sink: fake.sink });
  const sent = await before.stage('s'.repeat(9000));
  // The adapter dies between writing these and sending them.
  await before.stagePending('p'.repeat(9000));
  await before.stagePending('p'.repeat(9001));
  t.is(filesIn(first.blobDir).length, 1);
  t.is(partsIn(first.blobDir).length, 2);
  const after = makeBlobStore({ dir: first.blobDir, sink: fake.sink });
  await after.sweep();
  t.deepEqual(partsIn(first.blobDir), []);
  t.is(await after.read(sent.blob), 's'.repeat(9000));
  t.is(after.usage(undefined).daemon, 9000);
});

test('J-9361: the reply of a round is committed before roundFinal; a pending reply is never readable', async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const owner = Far('Session', {});
  const r = await runRound(
    blobs.store,
    { turns: [{ rounds: [{ chunks: [{ text: 'w'.repeat(20_000) }] }] }] },
    owner,
  );
  const [final] = r.finals;
  t.is(await blobs.store.read(final.text.blob, owner), 'w'.repeat(20_000));
  t.deepEqual(partsIn(blobs.blobDir), []);
  const pending = await blobs.store.stagePending('v'.repeat(9000));
  await t.throwsAsync(() => blobs.store.read(pending.blob), {
    message: texts.blobUnknown,
  });
  await blobs.store.commit([pending]);
  t.is(await blobs.store.read(pending.blob), 'v'.repeat(9000));
});

// ---------------------------------------------------------------- provenance

test('J-9364: a session cannot read the blob of another session through its ports', async t => {
  const first = makeTestBlobs();
  t.teardown(first.cleanup);
  const fake = makeFakeBlobSink();
  const impl = makeAgentHostImpl({ blobDir: first.blobDir, sink: fake.sink });
  const backend = Far('Backend', {});
  const spec = harden({
    kind: 'scripted',
    label: 'S',
    script: { turns: [] },
  });
  const a = Far('Session', {});
  const b = Far('Session', {});
  const portsA = await E(impl.ops).open(harden({ backend, spec, session: a }));
  const portsB = await E(impl.ops).open(harden({ backend, spec, session: b }));
  // A's exec result, written through A's writers.
  const writer = await E(portsA.writers).open();
  await E(writer).append('secret of A');
  const staged = await E(writer).close();
  const range = harden({ offset: 0, maxBytes: limits.blobPageBytes });
  t.is((await E(portsA.content).read(staged.blob, range)).text, 'secret of A');
  await t.throwsAsync(() => E(portsB.content).read(staged.blob, range), {
    message: texts.blobNotOwned,
  });
  // The incarnation's own Content (operators, tests, the gateway) reads any.
  const content = await E(impl.ops).content();
  t.is((await E(content).read(staged.blob, range)).text, 'secret of A');
});

test('J-9364: the context cache refuses a record that names a blob of another session; after a restart the first session to present a handle holds it', async t => {
  const first = makeTestBlobs();
  t.teardown(first.cleanup);
  const fake = makeFakeBlobSink();
  const store = makeBlobStore({ dir: first.blobDir, sink: fake.sink });
  const a = Far('Session', {});
  const b = Far('Session', {});
  const ofA = await store.stage('a'.repeat(9000), { owner: a });
  /** @param {any} input */
  const requestWith = input => {
    const records = makeRecordLog();
    const source = makeContextSource({ records });
    const record = { kind: 'turn-started', turnId: 't1', input, at: 1 };
    records.append(record);
    return harden({
      turnId: 't1',
      round: 0,
      base: { count: 0, epoch: 0 },
      append: [record],
      context: source,
    });
  };
  const cache = makeContextCache({ store });
  const forA = await cache.prepare(a, requestWith(ofA));
  t.is(forA.input, 'a'.repeat(9000));
  await t.throwsAsync(() => cache.prepare(b, requestWith(ofA)), {
    message: texts.blobNotOwned,
  });
  t.like(store.stats(), { refusedOwner: 1 });
  // A restart: the new incarnation knows no owner until one presents it.
  const again = makeBlobStore({ dir: first.blobDir, sink: fake.sink });
  const cache2 = makeContextCache({ store: again });
  const forA2 = await cache2.prepare(a, requestWith(ofA));
  t.is(forA2.input, 'a'.repeat(9000));
  t.is(again.usage(a).session, 9000, 'counted for A again');
  await t.throwsAsync(() => cache2.prepare(b, requestWith(ofA)), {
    message: texts.blobNotOwned,
  });
});

// ---------------------------------------------------------------- context cache (advisory 6)

test('J-9365: each prepare has its own timing (two sessions at once)', async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  // Reads of session A's blobs are slow, so B's prepare runs inside A's.
  const slow = new Set();
  const store = harden({
    resolveMany: blobs.store.resolveMany,
    /** @param {any} blob @param {any} owner */
    read: async (blob, owner) => {
      if (slow.has(blob)) await timers.delay(40);
      return blobs.store.read(blob, owner);
    },
  });
  const cache = makeContextCache({ store });
  // Every blob session A stages is slow to read.
  const storeA = harden({
    /** @param {string} text @param {any} options */
    stage: async (text, options) => {
      const staged = await blobs.store.stage(text, options);
      slow.add(staged.blob);
      return staged;
    },
  });
  const simA = makeSessionSim({
    seed: 3,
    store: storeA,
    stagedChance: 1,
    interruptedChance: 0,
    cancelChance: 0,
    toolChance: 0,
    nativeChance: 0,
  });
  const simB = makeSessionSim({
    seed: 4,
    store: blobs.store,
    stagedChance: 1,
    interruptedChance: 0,
    cancelChance: 0,
    toolChance: 0,
    nativeChance: 0,
  });
  /** @type {any[]} */
  const reqsA = [];
  /** @type {any[]} */
  const reqsB = [];
  await simA.turn(async req => {
    reqsA.push(req);
  });
  await simB.turn(async req => {
    reqsB.push(req);
  });
  const pa = cache.prepare(simA.session, reqsA[0]);
  await timers.delay(5);
  const pb = cache.prepare(simB.session, reqsB[0]);
  const [projA, projB] = /** @type {any[]} */ (await Promise.all([pa, pb]));
  t.true(slow.size >= 1);
  t.is(projA.timing.blobs, 1, "A's timing counts A's blob only");
  t.is(projB.timing.blobs, 1, "B's timing counts B's blob only");
  t.true(Number(projA.timing.readMs) >= 30, "A's timing has A's slow read");
  t.not(projA.timing, projB.timing);
});

test('J-9365: an entry over maxTextUnits on its own is dropped after its prepare', async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const cache = makeContextCache({ store: blobs.store, maxTextUnits: 1000 });
  const session = Far('Session', {});
  const input = await blobs.store.stage('m'.repeat(5000), { owner: session });
  const records = makeRecordLog();
  const source = makeContextSource({ records });
  const record = harden({ kind: 'turn-started', turnId: 't1', input, at: 1 });
  records.append(record);
  const projection = await cache.prepare(
    session,
    harden({
      turnId: 't1',
      round: 0,
      base: { count: 0, epoch: 0 },
      append: [record],
      context: source,
    }),
  );
  t.is(projection.input, 'm'.repeat(5000), 'the projection was built in full');
  t.false(cache.has(session), 'the oversize entry was not kept');
  t.is(cache.stats().textUnits, 0);
  t.is(cache.stats().oversize, 1);
});

// ---------------------------------------------------------------- list publisher (advisory 1)

test('J-9362: the manager tells its start listeners when a new adapter incarnation attaches outside a daemon start', async t => {
  /** @type {any} */
  let desired;
  // One state directory for every incarnation (HR-SYN-9: a store with no
  // directory reports a failed sweep).
  const stateDir = mkdtempSync(join(tmpdir(), 'w1b-kit-'));
  t.teardown(() => rmSync(stateDir, { recursive: true, force: true }));
  let incarnations = 0;
  /** @type {{ retired: boolean } | undefined} */
  let current;
  const bindFresh = async () => {
    incarnations += 1;
    const me = { retired: false };
    current = me;
    const impl = makeAgentHostImpl({
      incarnation: `fake-${incarnations}`,
      stateDir,
    });
    const ops = impl.ops;
    /** @param {() => Promise<any>} fn */
    const guard = fn => {
      if (me.retired) throw Error(HUB_RETIRED_MESSAGE);
      return fn();
    };
    const wrapper = Far('AgentHostOps', {
      listPublisher: () => guard(() => E(ops).listPublisher()),
    });
    await E(desired.sink).attach(wrapper, `fake-${incarnations}`);
  };
  const { facet: admin, lifecycle } = makeManagerVat({
    makeManager: () =>
      harden({
        /** @param {unknown} key @param {any} spec */
        register: async (key, spec) => {
          desired = spec;
          if (current === undefined || current.retired) await bindFresh();
          return harden({ handle: {}, status: { key, status: 'bound' } });
        },
        keys: () => harden(['agent-host']),
        lifecycle: Far('ManagerLifecycle', {
          started: async () => {
            if (desired !== undefined && (current?.retired ?? true))
              await bindFresh();
          },
          exited: async () => {},
        }),
      }),
  });
  /** @type {string[]} */
  const heard = [];
  const listener = Far('StartListener', {
    started: () => {
      heard.push('started');
    },
    attached: () => {
      heard.push('attached');
    },
  });
  await E(admin).onStart(listener);
  const first = await E(admin).listPublisher();
  t.deepEqual(heard, [], 'the first attach is no restart');
  // The adapter alone restarts: the next call reconciles and re-attaches.
  /** @type {any} */ (current).retired = true;
  const second = await E(admin).listPublisher();
  t.not(second, first);
  await until(() => heard.length === 1);
  t.deepEqual(heard, ['attached']);
  // A daemon start: listeners hear `started`, not `attached`.
  /** @type {any} */ (current).retired = true;
  await E(lifecycle).started();
  await until(() => heard.length === 2);
  await timers.delay(20);
  t.deepEqual(heard, ['attached', 'started']);
});
