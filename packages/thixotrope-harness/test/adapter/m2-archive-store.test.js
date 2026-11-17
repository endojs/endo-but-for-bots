// @ts-check
// M2 W2.8: the record archive's adapter side
// (resources/agent-host/impl/archive/*, context-cache.js archive path,
// blobs.js additions; designs/m2-interfaces.md 4). Node, a fake session vat
// that keeps the vat's side of the protocol (_m2-archive-vat.js), a real
// blob store, archive store and context cache over a directory under H/tmp;
// a restart is a fresh incarnation over the same directories and sink.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import {
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { inCallOrder } from '../../guest/session/records.js';
import { blobsOf } from '../../guest/session/staging.js';
/* eslint-enable import/no-relative-packages */
import { projectRecords } from '../../resources/agent-host/impl/projection.js';
import {
  chainDigest,
  encodeRecord,
  readSegment,
  writeSegment,
} from '../../resources/agent-host/impl/archive/segment.js';
import { archiveKeys } from '../../resources/agent-host/impl/archive/store.js';
import { makeOps } from '../../resources/agent-host/impl/attach.js';
import { makeFakeVat } from './_m2-archive-vat.js';
import {
  makeFakeSink,
  makeIncarnation,
  makeStateDir,
  normalise,
  oracleTranscript,
  referencePreview,
  withTexts,
} from './_m2-archive.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

/**
 * An oracle whose blob texts are read once.
 * @param {any} blobs
 */
const makeOracle = blobs => {
  /** @type {Map<any, string>} */
  const known = new Map();
  /** @param {readonly any[]} all */
  return async all => {
    for (const record of all) {
      for (const blob of blobsOf(record)) {
        // eslint-disable-next-line no-await-in-loop
        if (!known.has(blob)) known.set(blob, await blobs.read(blob));
      }
    }
    return projectRecords(all, { texts: known }).transcript;
  };
};

/**
 * Run `turns` turns of `vat`, preparing every request through the cache
 * and comparing with the oracle; seal after every turn; restart where
 * `restartAt` says.
 * @param {import('ava').ExecutionContext} t
 * @param {object} options
 * @param {any} options.vat
 * @param {any} options.dirs
 * @param {any} options.sink
 * @param {string} options.key
 * @param {number} options.turns
 * @param {(turn: number) => boolean} [options.restartAt]
 */
const drive = async (
  t,
  { vat, dirs, sink, key, turns, restartAt = () => false },
) => {
  let inc = makeIncarnation(dirs, sink);
  let oracle = makeOracle(inc.blobs);
  let port = inc.archive.portFor({ session: vat.session, key });
  /** @type {{ requests: number, restarts: number, rebuildPages: number[], seals: number }} */
  const report = { requests: 0, restarts: 0, rebuildPages: [], seals: 0 };
  let restarted = false;
  for (let n = 1; n <= turns; n += 1) {
    if (restartAt(n)) {
      inc = makeIncarnation(dirs, sink);
      oracle = makeOracle(inc.blobs);
      port = inc.archive.portFor({ session: vat.session, key });
      report.restarts += 1;
      restarted = true;
    }
    // eslint-disable-next-line no-await-in-loop
    await vat.turn(async (/** @type {any} */ req) => {
      const before = vat.counts.pages;
      const projection = await inc.cache.prepare(vat.session, req, { key });
      if (restarted) {
        report.rebuildPages.push(vat.counts.pages - before);
        restarted = false;
      }
      report.requests += 1;
      t.deepEqual(
        projection.transcript,
        await oracle(vat.all),
        `turn ${n} round ${req.round}`,
      );
    });
    // eslint-disable-next-line no-await-in-loop
    if (await vat.maybeSeal(port)) report.seals += 1;
  }
  return { inc, report, port };
};

test('segment: write, read, chain; every prefix of a file is refused', async t => {
  const dirs = await makeStateDir('w28s');
  t.teardown(dirs.cleanup);
  const dir = join(dirs.archiveDir, 'h1');
  await mkdir(dir, { recursive: true });
  const records = [
    { kind: 'turn-started', turnId: 't1', input: 'hi é😀', at: 1 },
    {
      kind: 'round-settled',
      turnId: 't1',
      round: 0,
      text: { $staged: { key: 'b7', preview: 'pre', bytes: 9000 } },
      callCount: 0,
      usage: {},
      at: 2,
    },
    { kind: 'turn-settled', turnId: 't1', status: 'completed', at: 3 },
  ];
  const header = {
    ordinal: 1,
    from: 0,
    to: 3,
    firstTurn: 1,
    turns: 1,
    bytes: 100,
    epoch: 0,
  };
  /** @type {string[]} */
  const steps = [];
  const one = await writeSegment(dir, header, records, '', {
    trace: step => steps.push(step),
  });
  t.deepEqual(steps, ['write', 'fsync', 'rename', 'fsync-dir']);
  t.regex(one.file, /^seg-000001-[0-9a-f]{16}\.jsonl$/);
  const read = await readSegment(join(dir, one.file));
  t.deepEqual(read.records, records);
  t.is(read.digest, one.digest);
  // The chain: a second segment's digest covers the first's.
  const two = await writeSegment(
    dir,
    { ...header, ordinal: 2, from: 3, to: 6, firstTurn: 2 },
    records,
    one.digest,
  );
  const bytes = await readFile(join(dir, two.file));
  const body = bytes.subarray(0, bytes.lastIndexOf(0x0a, bytes.length - 2) + 1);
  t.is(chainDigest(one.digest, body), two.digest);
  t.not(chainDigest('', body), two.digest);
  // Same range, same content: the file is verified and reused.
  const again = await writeSegment(
    dir,
    { ...header, ordinal: 2, from: 3, to: 6, firstTurn: 2 },
    records,
    one.digest,
  );
  t.true(again.reused);
  // Every prefix of a written file (the states a crash during the write
  // can leave behind, before the rename) is refused.
  const whole = await readFile(join(dir, one.file));
  const probe = join(dir, 'probe.jsonl');
  let refused = 0;
  for (let n = 0; n < whole.length; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    await writeFile(probe, whole.subarray(0, n));
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => readSegment(probe), undefined, `prefix ${n}`);
    refused += 1;
  }
  // A flipped byte does not verify.
  const flipped = Buffer.from(whole);
  flipped[40] = flipped[40] === 0x41 ? 0x42 : 0x41;
  await writeFile(probe, flipped);
  await t.throwsAsync(() => readSegment(probe));
  t.log({ fileBytes: whole.length, prefixesRefused: refused });
});

test('encodeRecord refuses a handle without a key', t => {
  const blob = Far('Blob', {});
  t.throws(
    () =>
      encodeRecord(
        { kind: 'x', text: { blob, preview: 'p', bytes: 1 } },
        () => undefined,
      ),
    { message: /no blob key/ },
  );
});

/**
 * @param {import('ava').ExecutionContext} t
 * @param {{ seed: number, turns: number, keepTurns?: number, segmentTurns?: number, restartEvery?: number }} options
 */
const property = async (
  t,
  { seed, turns, keepTurns = 8, segmentTurns = 4, restartEvery = 37 },
) => {
  const dirs = await makeStateDir('w28p');
  t.teardown(dirs.cleanup);
  const { sink, keyOf } = makeFakeSink();
  const first = makeIncarnation(dirs, sink);
  const vat = makeFakeVat({
    seed,
    store: first.blobs,
    keepTurns,
    segmentTurns,
  });
  const key = keyOf(vat.session);
  const { inc, report } = await drive(t, {
    vat,
    dirs,
    sink,
    key,
    turns,
    restartAt: n => n % restartEvery === 0,
  });
  t.true(vat.entries.length > 0, 'sealed');
  // A last restart: the rebuild reads the persisted projection and the
  // mirror, and pages at most one gap from the vat.
  const again = makeIncarnation(dirs, sink);
  const before = vat.counts.pages;
  const req = vat.request('t-check', 0, false);
  const projection = await again.cache.prepare(vat.session, req, { key });
  t.deepEqual(
    projection.transcript,
    await oracleTranscript(vat.all, again.blobs),
  );
  const pages = vat.counts.pages - before;
  t.true(pages <= 1, `rebuild paged ${pages} times`);
  t.log({
    seed,
    turns,
    segments: vat.entries.length,
    sealedTurns: vat.sealedTurns(),
    records: vat.all.length,
    kept: vat.kept().length,
    ...report,
    lastRebuildPages: pages,
    cache: again.cache.stats(),
    archive: inc.archive.stats(),
  });
};

test('property: incremental and rebuilt context through segments equal the oracle (small segments)', async t => {
  for (const seed of [1, 2, 3]) {
    // eslint-disable-next-line no-await-in-loop
    await property(t, { seed, turns: 110 });
  }
});

test('property: real limits, 330 turns (128 kept, 32 per segment)', async t => {
  await property(t, {
    seed: 11,
    turns: 330,
    keepTurns: limits.archiveKeepTurns,
    segmentTurns: limits.archiveSegmentTurns,
    restartEvery: 250,
  });
});

test('history: pages back to turn 1, every turn once; sealed previews and content equal the full list', async t => {
  const dirs = await makeStateDir('w28h');
  t.teardown(dirs.cleanup);
  const { sink, keyOf } = makeFakeSink();
  const first = makeIncarnation(dirs, sink);
  const vat = makeFakeVat({
    seed: 5,
    store: first.blobs,
    keepTurns: 8,
    segmentTurns: 4,
    unknownChance: 0.15,
    resolveChance: 0.4,
  });
  const key = keyOf(vat.session);
  await drive(t, { vat, dirs, sink, key, turns: 90 });
  // A fresh incarnation that never served the session: History learns the
  // key from the manager and the archive state from the vat's newest page.
  const inc = makeIncarnation(dirs, sink);
  /** @type {string[]} */
  const seen = [];
  let sealedPages = 0;
  /** @type {any} */
  let page = await E(inc.history).page(vat.session);
  for (;;) {
    for (const turn of page.turns) {
      seen.push(turn.turnId);
      const ordinal = Number(turn.turnId.slice(1));
      const full = vat.recordsOfTurn(ordinal, vat.sealedTo());
      t.is(turn.at, vat.turns[ordinal - 1].at);
      if (turn.sealed) {
        t.is(turn.state, vat.turns[ordinal - 1].status);
        t.deepEqual(
          turn.records.map(normalise),
          inCallOrder(full).map(referencePreview),
          `sealed preview of ${turn.turnId}`,
        );
        const resolved = full.find(r => r.kind === 'turn-resolved');
        t.is(turn.resolution, resolved?.note);
      }
    }
    if (page.next === undefined) break;
    // eslint-disable-next-line no-await-in-loop
    page = await E(inc.history).page(vat.session, page.next);
    if (page.turns[0]?.sealed) sealedPages += 1;
  }
  const expected = vat.turns.map(turn => turn.turnId).reverse();
  t.deepEqual(seen, expected, 'every turn once, newest first');
  t.true(sealedPages > 0);
  // Full content of every sealed turn equals the full list, texts included.
  for (let ordinal = 1; ordinal <= vat.sealedTurns(); ordinal += 1) {
    const turnId = `t${ordinal}`;
    /** @type {any[]} */
    const got = [];
    /** @type {string | undefined} */
    let cursor;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const content = await E(inc.history).turnContent(
        vat.session,
        turnId,
        ...(cursor === undefined ? [] : [cursor]),
      );
      got.push(...content.records);
      if (content.next === undefined) break;
      cursor = content.next;
    }
    const full = vat.recordsOfTurn(ordinal, vat.sealedTo());
    /* eslint-disable no-await-in-loop */
    t.deepEqual(
      await withTexts(got, inc.blobs),
      await withTexts(inCallOrder(full), inc.blobs),
      `content of ${turnId}`,
    );
    /* eslint-enable no-await-in-loop */
  }
  await t.throwsAsync(() => E(inc.history).turnContent(vat.session, 't99999'), {
    message: texts.unknownTurn,
  });
  const lastKept = `t${vat.turns.length}`;
  await t.throwsAsync(() => E(inc.history).turnContent(vat.session, lastKept), {
    message: texts.unknownTurn,
  });
});

test('validation: orphans deleted, half-written files ignored, a missing segment is data loss', async t => {
  const dirs = await makeStateDir('w28v');
  t.teardown(dirs.cleanup);
  const { sink, keyOf } = makeFakeSink();
  const first = makeIncarnation(dirs, sink);
  const vat = makeFakeVat({
    seed: 9,
    store: first.blobs,
    keepTurns: 6,
    segmentTurns: 3,
  });
  const key = keyOf(vat.session);
  const { inc } = await drive(t, { vat, dirs, sink, key, turns: 30 });
  const dir = join(dirs.archiveDir, key);
  t.true(vat.entries.length >= 3);
  // An orphan: a seal answered by an earlier incarnation and never
  // acknowledged (the vat got the retired break), plus a half-written one.
  let req = vat.startSeal();
  while (req === undefined) {
    // eslint-disable-next-line no-await-in-loop
    await vat.turn(async (/** @type {any} */ r) => {
      await inc.cache.prepare(vat.session, r, { key });
    });
    req = vat.startSeal();
  }
  const orphan = await inc.archive.portFor({ session: vat.session, key });
  const answer = await E(orphan).seal(req);
  vat.notSealed();
  await writeFile(join(dir, 'seg-000099-0123456789abcdef.jsonl'), '{"format"');
  await writeFile(join(dir, `${answer.digest}.part`), 'torn');
  const restart = makeIncarnation(dirs, sink);
  t.is(await restart.archive.sweep(), 1, 'the .part file');
  const before = (await readdir(dir)).filter(n => n.startsWith('seg-'));
  t.true(before.some(n => n.includes(answer.digest.slice(0, 16))));
  // The next request validates: the orphan and the broken file go.
  const projection = await restart.cache.prepare(
    vat.session,
    vat.request('t-v', 0),
    { key },
  );
  t.deepEqual(
    projection.transcript,
    await oracleTranscript(vat.all, restart.blobs),
  );
  const after = (await readdir(dir)).filter(n => n.startsWith('seg-'));
  t.is(after.length, vat.entries.length);
  t.false(after.some(n => n.includes(answer.digest.slice(0, 16))));
  // The context file and manifest are caches: deleted, rebuilt.
  await unlink(join(dir, 'context.jsonl'));
  await unlink(join(dir, 'manifest.json'));
  const rebuilt = makeIncarnation(dirs, sink);
  const again = await rebuilt.cache.prepare(
    vat.session,
    vat.request('t-w', 0),
    { key },
  );
  t.deepEqual(again.transcript, await oracleTranscript(vat.all, rebuilt.blobs));
  // An acknowledged segment that is gone is data loss.
  await unlink(join(dir, after.sort()[1]));
  const lost = makeIncarnation(dirs, sink);
  await t.throwsAsync(
    () => lost.cache.prepare(vat.session, vat.request('t-x', 0), { key }),
    { message: textOf.archiveFailed('segment 2 is missing') },
  );
});

test('seal refuses a wrong fingerprint, an unknown previous digest and a gap', async t => {
  const dirs = await makeStateDir('w28f');
  t.teardown(dirs.cleanup);
  const { sink, keyOf } = makeFakeSink();
  const first = makeIncarnation(dirs, sink);
  const vat = makeFakeVat({
    seed: 4,
    store: first.blobs,
    keepTurns: 6,
    segmentTurns: 3,
  });
  const key = keyOf(vat.session);
  // Grow without sealing, then try bad requests.
  for (let n = 0; n < 12; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    await vat.turn(async (/** @type {any} */ req) => {
      await first.cache.prepare(vat.session, req, { key });
    });
  }
  const port = first.archive.portFor({ session: vat.session, key });
  const req = /** @type {any} */ (vat.startSeal());
  vat.notSealed();
  const bad = [
    { ...req, kinds: `x${req.kinds.slice(1)}` },
    { ...req, firstTurnId: 't99' },
    { ...req, lastTurnId: 't1' },
    { ...req, turns: req.turns + 1 },
    { ...req, records: req.records - 1, to: req.to - 1 },
    { ...req, previous: 'a'.repeat(64) },
    { ...req, from: 1 },
  ];
  for (const one of bad) {
    // eslint-disable-next-line no-await-in-loop
    const error = await t.throwsAsync(() => E(port).seal(harden(one)));
    t.true(error?.message.startsWith(textOf.archiveFailed('')), error?.message);
  }
  const dir = join(dirs.archiveDir, key);
  const files = await readdir(dir).catch(() => []);
  t.false(
    files.some(n => n.startsWith('seg-')),
    'nothing written',
  );
  // The good one is accepted.
  const answer = await E(port).seal(req);
  t.is(answer.to, req.to);
  t.is(first.archive.stats().sealFailures, bad.length);
});

test('release deletes the blob files the archive names and its directory; archiveKeys lists them', async t => {
  const dirs = await makeStateDir('w28r');
  t.teardown(dirs.cleanup);
  const { sink, keyOf } = makeFakeSink();
  const first = makeIncarnation(dirs, sink);
  const vat = makeFakeVat({
    seed: 6,
    store: first.blobs,
    keepTurns: 6,
    segmentTurns: 3,
    stagedChance: 0.5,
  });
  const key = keyOf(vat.session);
  const { inc } = await drive(t, { vat, dirs, sink, key, turns: 25 });
  const keys = await archiveKeys(dirs.archiveDir);
  t.true(keys.size > 0);
  for (const name of keys) {
    // eslint-disable-next-line no-await-in-loop
    t.truthy(await stat(join(dirs.blobDir, name)));
  }
  await inc.archive.release(key);
  await inc.archive.release(key);
  for (const name of keys) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => stat(join(dirs.blobDir, name)));
  }
  await t.throwsAsync(() => stat(join(dirs.archiveDir, key)));
  t.is((await archiveKeys(dirs.archiveDir)).size, 0);
});

test('a stale vat state never deletes a segment the vat may still acknowledge', async t => {
  const dirs = await makeStateDir('w28g');
  t.teardown(dirs.cleanup);
  const { sink, keyOf } = makeFakeSink();
  const first = makeIncarnation(dirs, sink);
  const vat = makeFakeVat({
    seed: 8,
    store: first.blobs,
    keepTurns: 6,
    segmentTurns: 3,
  });
  const key = keyOf(vat.session);
  const { inc, port } = await drive(t, { vat, dirs, sink, key, turns: 20 });
  let req = vat.startSeal();
  while (req === undefined) {
    // eslint-disable-next-line no-await-in-loop
    await vat.turn(async (/** @type {any} */ r) => {
      await inc.cache.prepare(vat.session, r, { key });
    });
    req = vat.startSeal();
  }
  const older = vat.state();
  // A seal answered, its acknowledgment not yet seen; a history page
  // answered before the seal (state `older`) arrives meanwhile.
  const answer = await E(port).seal(req);
  await inc.archive.observe(vat.session, key, older);
  t.true(vat.sealed(answer));
  const dir = join(dirs.archiveDir, key);
  const files = (await readdir(dir)).filter(n => n.startsWith('seg-'));
  t.true(files.some(n => n.includes(answer.digest.slice(0, 16))));
  // The new state acknowledges it; an older one afterwards changes nothing.
  await inc.archive.observe(vat.session, key, vat.state());
  await inc.archive.observe(vat.session, key, older);
  const entries = await inc.archive.entriesOf(key);
  t.is(entries.length, vat.entries.length);
  t.is(entries[entries.length - 1].digest, answer.digest);
  const projection = await inc.cache.prepare(
    vat.session,
    vat.request('t-s', 0),
    { key },
  );
  t.deepEqual(
    projection.transcript,
    await oracleTranscript(vat.all, inc.blobs),
  );
});

test('without a key from open the manager names it; without one a request with an archive fails', async t => {
  const dirs = await makeStateDir('w28k');
  t.teardown(dirs.cleanup);
  const { sink, keyOf, counts } = makeFakeSink();
  const vat = makeFakeVat({ seed: 3, keepTurns: 4, segmentTurns: 2 });
  const key = keyOf(vat.session);
  await drive(t, { vat, dirs, sink, key, turns: 10 });
  t.truthy(vat.state());
  // A port and a cache told no key: the manager's resolveSessions, once.
  const named = makeIncarnation(dirs, sink);
  const before = counts.resolveSessions;
  const projection = await named.cache.prepare(
    vat.session,
    vat.request('t-n', 0),
  );
  t.deepEqual(
    projection.transcript,
    await oracleTranscript(vat.all, named.blobs),
  );
  const port = named.archive.portFor({ session: vat.session });
  let req = vat.startSeal();
  while (req === undefined) {
    // eslint-disable-next-line no-await-in-loop
    await vat.turn(async (/** @type {any} */ r) => {
      await named.cache.prepare(vat.session, r);
    });
    req = vat.startSeal();
  }
  t.true(vat.sealed(await E(port).seal(req)));
  t.is(counts.resolveSessions - before, 1);
  // A manager without archive keys: the round fails rather than leave the
  // sealed part out of the context.
  const blobOnly = Far('AgentHostSink', {
    mintBlobs: () => E(sink).mintBlobs(),
    /** @param {any[]} blobs */
    resolveBlobs: blobs => E(sink).resolveBlobs(blobs),
  });
  const keyless = makeIncarnation(dirs, blobOnly);
  await t.throwsAsync(
    () => keyless.cache.prepare(vat.session, vat.request('t-o', 0)),
    { message: textOf.archiveFailed('no archive for this session here') },
  );
});

test('ops facet: M2 methods forward to their handlers or throw notBuilt', async t => {
  const calls = [];
  const ops = makeOps({
    open: () => {
      throw Error('unused');
    },
    liveChannel: () => undefined,
    live: () => undefined,
    composer: () => undefined,
    content: () => undefined,
    releaseArchive: async (/** @type {string} */ key) => {
      calls.push(['releaseArchive', key]);
      return 'ignored';
    },
    releaseBlobs: async (/** @type {string[]} */ keys) => {
      calls.push(['releaseBlobs', keys]);
    },
  });
  t.is(await E(ops).releaseArchive('h3'), undefined);
  t.is(await E(ops).releaseBlobs(['b1', 'b2']), undefined);
  t.deepEqual(calls, [
    ['releaseArchive', 'h3'],
    ['releaseBlobs', ['b1', 'b2']],
  ]);
  for (const [name, args] of /** @type {Array<[string, any[]]>} */ ([
    ['history', []],
    ['writersFor', []],
    ['secretRevoke', ['k1']],
    ['secretWriter', []],
  ])) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () => /** @type {any} */ (E(ops))[name](...args),
      { message: textOf.notBuilt(name) },
      name,
    );
  }
});
