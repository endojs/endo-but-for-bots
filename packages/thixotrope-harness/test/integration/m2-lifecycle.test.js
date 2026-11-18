// @ts-check
/**
 * M2 acceptance 13 and 14 (milestones.md M2; m2-interfaces.md 7; W2.7),
 * through the daemon from the m1a state template (the real session and
 * factory programs, the scripted backend):
 *
 * 13. SIGKILL during `deleteSession`: after the restart the delete
 *     completes, the session's vats and archive are gone; SIGKILL during
 *     `createSession`: after the restart nothing half-made is listed. Two
 *     list-feed subscribers see the delete (`row-removed`) within 500 ms.
 * 14 (export and import) is in m2-lifecycle-export.test.js (split for the
 * 5-minute file budget, J-9493).
 *
 * Also measured: `disk.session` (an idle session of 300 turns, built by
 * `importState`; and what its delete returns), the delete's duration and
 * the import rate of those 300 turns.
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m2-lifecycle -- \
 *     corepack yarn test test/integration/m2-lifecycle.test.js
 */
import '../unit/_m1a-prelude.js';

import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { emit, loadAvg, runIdentity } from '../../perf/_harness.mjs';
import { importState } from '../../scripts/export.mjs';
import { inputs, sliceScript } from '../fixtures/scripts/m1a-slice.js';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
  tmpRoot,
  shortName,
} from '../template/index.js';
import {
  collect,
  makeSlice,
  round1,
  sliceTemplate,
  untilAsleep,
  waitFor,
} from './_m1a-slice.js';
import { diskOf, vatDisk, writeSyntheticExport } from './_m2-lifecycle.js';

takeIntegrationLock(test, 'm2 lifecycle test');

/** Export files this file wrote (removed at the end). */
/** @type {string[]} */
const files = [];
test.after.always(() =>
  Promise.all(files.map(file => rm(file, { force: true }))),
);

const run = integrationEnabled ? test.serial : test.skip;

/**
 * W2.9 repeats acceptance 13's SIGKILL cases at varied kill points: the
 * delete is killed this long after its row reads `deleting`, the creation
 * this long after the call (or at its new vat, whichever is first).
 */
const DELETE_KILL_DELAY_MS = Number(process.env.M2_DELETE_KILL_DELAY_MS ?? 0);
const CREATE_KILL_DELAY_MS = Number(process.env.M2_CREATE_KILL_DELAY_MS ?? 300);

/** @type {Awaited<ReturnType<typeof sliceTemplate>> | undefined} */
let template;
/** @param {import('ava').ExecutionContext} t */
const open = async t => {
  template ??= await sliceTemplate();
  const state = await startFromTemplate(template, { t });
  const slice = await makeSlice(state);
  const made = await slice.makeBackend(harden(sliceScript));
  return { state, slice, ...made };
};

/** @param {any} slice */
const listViewers = async slice => {
  const { rev } = await E(slice.factory).sessionListFeed();
  const a = collect(await E(slice.live).subscribeList(rev));
  const b = collect(await E(slice.live).subscribeList(rev));
  return { a, b };
};

/**
 * The archive directories under a state (`h<n>`, one per session that
 * sealed or mirrored).
 * @param {string} root
 */
const archiveDirs = async root =>
  new Set(
    await readdir(path.join(root, 'agent-host', 'archive')).catch(() => []),
  );

/** @param {any} slice */
const listedKeys = async slice =>
  (await E(slice.factory).listSessions()).rows.map(
    (/** @type {any} */ row) => row.key,
  );

/**
 * Import synthetic sessions into a served state.
 * @param {any} state
 * @param {any} backend
 * @param {import('./_m2-lifecycle.js').SyntheticSession[]} sessions
 */
const importSynthetic = async (state, backend, sessions) => {
  const file = path.join(tmpRoot, `${shortName('x')}.jsonl`);
  files.push(file);
  const written = await writeSyntheticExport(file, sessions);
  const result = await importState({
    client: state.client,
    file,
    backends: [backend],
  });
  return { ...result, file, fileBytes: written.bytes };
};

/**
 * Every turn id of a session, newest first, through the vat and History.
 * @param {any} slice
 * @param {any} s
 */
const allTurnIds = async (slice, s) => {
  const history = await E(slice.admin).history();
  /** @type {string[]} */
  const ids = [];
  /** @type {any} */
  let page = await E(history).page(s);
  for (;;) {
    for (const turn of page.turns) ids.push(turn.turnId);
    if (page.next === undefined) break;
    // eslint-disable-next-line no-await-in-loop
    page = await E(history).page(s, page.next);
  }
  return ids;
};

run(
  '13: delete publishes row-removed to two viewers within 500 ms; disk of a 300-turn session returned',
  async t => {
    t.timeout(4 * 60_000);
    const { state, slice, backend } = await open(t);
    const { a, b } = await listViewers(slice);
    t.teardown(() => Promise.all([a.stop(), b.stop()]));
    const disk0 = await diskOf(state.root);

    // An idle session of 300 turns, built by importState (it seals as it
    // goes: 128-159 turns stay in the vat).
    const built = await importSynthetic(state, backend, [
      { title: 'three hundred', turns: 300, backendLabel: 'Scripted' },
    ]);
    const [session] = built.sessions;
    const { key } = await E(session).getInfo();
    emit({
      metric: 'import.rate',
      unit: 'turns/s',
      turns: built.turns,
      records: built.records,
      chunks: built.chunks,
      waits: built.waits,
      waitMs: built.waitMs,
      ms: built.ms,
      turnsPerSecond: round1((built.turns * 1000) / built.ms),
      fileBytes: built.fileBytes,
      by: 'W2.7',
      ...(await runIdentity()),
      loadAvg: loadAvg(),
    });
    const ids = await allTurnIds(slice, session);
    t.is(ids.length, 300, 'every turn once, archived and kept');
    t.is(new Set(ids).size, 300);
    /** @type {any} */
    const head = await E(session).getHistoryPage();
    t.truthy(head.archive, 'the import sealed segments');
    t.true(Number(head.archive.sealedTurns) >= 300 - 159);

    await untilAsleep(
      () => slice.workers(),
      w => w.debugLabel === `session ${key}`,
    );
    const disk1 = await diskOf(state.root);
    const vat1 = await vatDisk(state.root, `session ${key}`);
    t.true(vat1.found);
    // The session's own bytes: its vat (journal, snapshot, incarnation
    // files), its archive directory and its blob files. Whole-directory
    // deltas are not used: other vats' snapshots come and go meanwhile.
    const archiveAdded = disk1.archive - disk0.archive;
    const blobAdded = disk1.blobs - disk0.blobs;
    const sessionBytes = vat1.total + archiveAdded;
    emit({
      metric: 'disk.session',
      unit: 'bytes',
      turns: 300,
      bytes: sessionBytes,
      MB: round1(sessionBytes / 1e6),
      vat: vat1,
      archiveBytes: archiveAdded,
      blobBytes: blobAdded,
      stateDeltaBytes: disk1.total - disk0.total,
      budget: '<= 25 MB plus blobs',
      pass: sessionBytes <= 25e6,
      by: 'W2.7',
      ...(await runIdentity()),
      loadAvg: loadAvg(),
    });
    // A perf row (emitted above with its pass), not an acceptance check.
    t.log(`disk.session ${sessionBytes} bytes (budget 25 MB plus blobs)`);

    // 13: the delete; both viewers see row-removed.
    const d0 = Date.now();
    await E(slice.factory).deleteSession(session);
    const answeredAt = Date.now();
    const arrivals = await Promise.all(
      [a, b].map(async viewer => {
        const i = await viewer.until(
          e => e.type === 'row-removed' && e.key === key,
          10_000,
        );
        return viewer.deliveries[i].arrivedAt;
      }),
    );
    const late = Math.max(...arrivals) - answeredAt;
    t.true(late <= 500, `row-removed ${late} ms after the answer`);
    t.deepEqual(await listedKeys(slice), []);
    await t.throwsAsync(() => E(slice.factory).findSession(key), {
      message: texts.unknownSession,
    });
    // The delete is done when it answers; files of a retired worker may
    // leave a moment later.
    const worker = await slice.sessionWorker(key);
    t.is(worker, undefined, 'the session vat is retired');
    const disk2 = await waitFor(
      async () => {
        const now = await diskOf(state.root);
        return now.archive - disk0.archive <= 0 && now.blobs - disk0.blobs <= 0
          ? now
          : undefined;
      },
      10_000,
      'the archive and its blobs released',
    );
    const vat2 = await vatDisk(state.root, `session ${key}`);
    emit({
      metric: 'disk.session.deleted',
      unit: 'bytes',
      turns: 300,
      deleteMs: answeredAt - d0,
      rowRemovedAfterAnswerMs: late,
      rowRemovedAfterCallMs: Math.max(...arrivals) - d0,
      returnedBytes:
        sessionBytes - (vat2.total + disk2.archive - disk0.archive),
      leftVat: vat2,
      leftArchiveBytes: disk2.archive - disk0.archive,
      leftBlobBytes: disk2.blobs - disk0.blobs,
      by: 'W2.7',
      ...(await runIdentity()),
      loadAvg: loadAvg(),
    });
    t.is(vat2.total, 0, 'the session vat files are gone');
    t.is(disk2.archive - disk0.archive, 0, 'the archive directory is gone');
    t.true(disk2.blobs - disk0.blobs <= 0, 'its blob files are gone');
  },
);

run(
  '13: SIGKILL during deleteSession and during createSession; the restart completes the delete and lists nothing half-made',
  async t => {
    t.timeout(4 * 60_000);
    const { state, slice, backend } = await open(t);
    // A session with an archive and a kept tail.
    const dirsBefore = await archiveDirs(state.root);
    const blobsBefore = (await diskOf(state.root)).blobs;
    const built = await importSynthetic(state, backend, [
      { title: 'to delete', turns: 170, backendLabel: 'Scripted' },
    ]);
    const [doomed] = built.sessions;
    const { key } = await E(doomed).getInfo();
    const keep = await slice.createSession(backend, 'kept');
    await slice.submit(keep, inputs.hi);
    const archiveDir = path.join(state.root, 'agent-host', 'archive');
    const before = await diskOf(state.root);
    t.true(before.archive > 0);
    // The doomed session's own archive directories (the template's other
    // sessions and the kept one, made after this, are not among them).
    const doomedDirs = [...(await archiveDirs(state.root))].filter(
      name => !dirsBefore.has(name),
    );
    t.true(doomedDirs.length > 0, 'the import made an archive directory');

    // Kill as soon as the row says `deleting` (step 1 ran).
    const { a } = await listViewers(slice);
    void E(slice.factory)
      .deleteSession(doomed)
      .catch(() => undefined);
    await a.until(
      e => e.type === 'row' && e.row.key === key && e.row.state === 'deleting',
      30_000,
    );
    // W2.9: M2_DELETE_KILL_DELAY_MS moves the kill later into the delete.
    if (DELETE_KILL_DELAY_MS > 0)
      await new Promise(resolve => setTimeout(resolve, DELETE_KILL_DELAY_MS));
    await state.kill();
    await state.restart();
    await slice.refresh();
    await waitFor(
      async () => !(await listedKeys(slice)).includes(key),
      60_000,
      'the delete completed after the restart',
    );
    t.deepEqual(await listedKeys(slice), ['s2']);
    t.is(await slice.sessionWorker(key), undefined, 'its vat is retired');
    const after = await waitFor(
      async () => {
        const now = await diskOf(state.root);
        const dirs = await archiveDirs(state.root);
        return now.archive < before.archive &&
          now.blobs <= blobsBefore &&
          doomedDirs.every(name => !dirs.has(name))
          ? now
          : undefined;
      },
      10_000,
      'its archive directory and blob files released',
    );
    const leftDirs = [...(await archiveDirs(state.root))].filter(
      name => !dirsBefore.has(name),
    );
    emit({
      metric: 'm2.lifecycle.deleteKill',
      killDelayMs: DELETE_KILL_DELAY_MS,
      archiveBefore: before.archive,
      archiveAfter: after.archive,
      blobsBefore,
      blobsAfter: after.blobs,
      doomedDirs,
      // The kept session's own directory (its mirror of the live tail)
      // accounts for what stays under the archive root (J-9493).
      otherNewDirs: leftDirs,
      by: 'W2.7',
    });
    t.true(
      doomedDirs.every(name => !leftDirs.includes(name)),
      'the doomed archive directory is gone',
    );
    t.true(after.blobs <= blobsBefore, 'its blob files are gone');
    t.true(
      (await stat(archiveDir).catch(() => undefined)) === undefined ||
        after.archive < before.archive,
    );

    // createSession killed while it runs (once a new worker appears, or
    // CREATE_KILL_DELAY_MS, default 300 ms, after the call when a spare was
    // taken): nothing half-made after.
    const workersBefore = new Set(
      (await slice.workers()).map((/** @type {any} */ w) => w.workerId),
    );
    const c0 = Date.now();
    const creating = E(slice.factory)
      .createSession(harden({ title: 'cut', backend, at: Date.now() }))
      .catch(() => undefined);
    await waitFor(
      async () =>
        Date.now() - c0 > CREATE_KILL_DELAY_MS ||
        (await slice.workers()).some(
          (/** @type {any} */ w) => !workersBefore.has(w.workerId),
        ),
      30_000,
      'a new vat or 300 ms',
      20,
    );
    const killedAfterMs = Date.now() - c0;
    await state.kill();
    await creating;
    await state.restart();
    await slice.refresh();
    // Every listed row is whole: ready, and the factory holds no other row.
    const settled = await waitFor(
      async () => {
        const page = await E(slice.factory).listSessions();
        const status = await E(slice.harness).status();
        return status.sessions === page.rows.length ? page : undefined;
      },
      30_000,
      'no half-made row',
    );
    t.true(
      settled.rows.every((/** @type {any} */ r) => r.state === 'ready'),
      JSON.stringify(settled.rows.map((/** @type {any} */ r) => r.state)),
    );
    t.true(settled.rows.some((/** @type {any} */ r) => r.key === 's2'));
    emit({
      metric: 'm2.lifecycle.createKill',
      killedAfterMs,
      listed: settled.rows.map((/** @type {any} */ r) => r.key),
      by: 'W2.7',
    });
    // The kept session still works.
    const s2 = await E(slice.factory).findSession('s2');
    const receipt = await slice.submit(s2, inputs.hi);
    t.is(receipt.state, 'started');
  },
);
