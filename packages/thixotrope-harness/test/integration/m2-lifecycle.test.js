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
 * 14. `exportState` then `importState` into a fresh state directory yields
 *     the same sessions, history and queues (presets are M5).
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

import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import { emit, loadAvg, runIdentity } from '../../perf/_harness.mjs';
import { exportState, importState } from '../../scripts/export.mjs';
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
        return now.archive - disk0.archive <= 0 ? now : undefined;
      },
      10_000,
      'the archive released',
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
  },
);

run(
  '13: SIGKILL during deleteSession and during createSession; the restart completes the delete and lists nothing half-made',
  async t => {
    t.timeout(4 * 60_000);
    const { state, slice, backend } = await open(t);
    // A session with an archive and a kept tail.
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

    // Kill as soon as the row says `deleting` (step 1 ran).
    const { a } = await listViewers(slice);
    void E(slice.factory)
      .deleteSession(doomed)
      .catch(() => undefined);
    await a.until(
      e => e.type === 'row' && e.row.key === key && e.row.state === 'deleting',
      30_000,
    );
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
        return now.archive < before.archive ? now : undefined;
      },
      10_000,
      'its archive released',
    );
    emit({
      metric: 'm2.lifecycle.deleteKill',
      archiveBefore: before.archive,
      archiveAfter: after.archive,
      by: 'W2.7',
    });
    t.true(
      (await stat(archiveDir).catch(() => undefined)) === undefined ||
        after.archive < before.archive,
    );

    // createSession killed while it runs (once a new worker appears, or
    // 300 ms after the call when a spare was taken): nothing half-made after.
    const workersBefore = new Set(
      (await slice.workers()).map((/** @type {any} */ w) => w.workerId),
    );
    const c0 = Date.now();
    const creating = E(slice.factory)
      .createSession(harden({ title: 'cut', backend, at: Date.now() }))
      .catch(() => undefined);
    await waitFor(
      async () =>
        Date.now() - c0 > 300 ||
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

/**
 * The export of a state as text lines with the keys a state assigns
 * itself left out (backend presences, staged previews are equal anyway).
 * @param {string} file
 */
const exportLines = async file =>
  (await readFile(file, 'utf8')).trim().split('\n');

run(
  '14: export then import into a fresh state yields the same sessions, history and queues',
  async t => {
    t.timeout(4 * 60_000);
    const source = await open(t);
    const { slice, backend } = source;
    // s1: turns run normally, then a restart holds two waiting messages.
    const chat = await slice.createSession(backend, 'chat');
    await slice.submit(chat, inputs.hi);
    await slice.submit(chat, inputs.echoOne);
    await slice.submit(chat, inputs.stall);
    await slice.submit(chat, 'later one');
    await slice.submit(chat, 'later two');
    await source.state.kill();
    await source.state.restart();
    await slice.refresh();
    const s1 = await E(slice.factory).findSession('s1');
    const held = await waitFor(
      async () => {
        const pending = await E(s1).listPending();
        return pending.hold === undefined ? undefined : pending;
      },
      30_000,
      'the restart hold',
    );
    // Whatever had not started at the kill waits, in order.
    const heldPreviews = held.entries.map((/** @type {any} */ e) => e.preview);
    t.deepEqual(heldPreviews.slice(-2), ['later one', 'later two']);
    // s2: an archived session (sealed segments are read through History).
    // The backend presence died with the client the kill closed: a new
    // scripted backend with the same label.
    const again = await slice.makeBackend(harden(sliceScript));
    await importSynthetic(source.state, again.backend, [
      { title: 'archived', turns: 170, backendLabel: 'Scripted' },
    ]);
    const s2 = await E(slice.factory).findSession('s2');
    t.truthy((await E(s2).getHistoryPage()).archive);

    t.log('stage: source history', new Date().toISOString());
    const sourceHistory = (await E(s1).getHistoryPage()).turns.map(
      (/** @type {any} */ p) => [p.turnId, p.state, p.records.length],
    );
    const file1 = path.join(tmpRoot, `${shortName('e')}.jsonl`);
    files.push(file1);
    t.log('stage: export source', new Date().toISOString());
    const exported = await exportState({
      client: source.state.client,
      file: file1,
    });
    t.is(exported.sessions, 2);
    t.true(exported.archivedTurns >= 32);
    t.log('stage: cleanup source', new Date().toISOString());
    await source.state.cleanup();

    // A fresh state: the same backend label, then the import.
    t.log('stage: open target', new Date().toISOString());
    const target = await open(t);
    t.log('stage: import target', new Date().toISOString());
    const imported = await importState({
      client: target.state.client,
      file: file1,
      backends: [target.backend],
    });
    t.is(imported.sessions.length, exported.sessions);
    const file2 = path.join(tmpRoot, `${shortName('e')}.jsonl`);
    files.push(file2);
    t.log('stage: export target', new Date().toISOString());
    await exportState({ client: target.state.client, file: file2 });
    const [one, two] = await Promise.all([
      exportLines(file1),
      exportLines(file2),
    ]);
    t.is(two.length, one.length);
    for (let i = 0; i < one.length; i += 1) {
      t.deepEqual(JSON.parse(two[i]), JSON.parse(one[i]), `line ${i + 1}`);
    }
    // The queue and its hold, the history pages, through the objects.
    t.log('stage: compare', new Date().toISOString());
    const t1 = await E(target.slice.factory).findSession('s1');
    const pending = await E(t1).listPending();
    t.deepEqual(
      pending.entries.map((/** @type {any} */ e) => e.preview),
      heldPreviews,
    );
    t.is(pending.hold?.reason, 'restart');
    const shown = (/** @type {any} */ page) =>
      page.turns.map((/** @type {any} */ p) => [
        p.turnId,
        p.state,
        p.records.length,
      ]);
    t.deepEqual(shown(await E(t1).getHistoryPage()), sourceHistory);
    const t2 = await E(target.slice.factory).findSession('s2');
    t.log('stage: walk', new Date().toISOString());
    const ids = await allTurnIds(target.slice, t2);
    t.is(ids.length, 170);
    emit({
      metric: 'm2.lifecycle.exportImport',
      exportMs: exported.ms,
      importMs: imported.ms,
      records: imported.records,
      lines: one.length,
      limits: {
        keep: limits.archiveKeepTurns,
        segment: limits.archiveSegmentTurns,
      },
      by: 'W2.7',
    });
  },
);
