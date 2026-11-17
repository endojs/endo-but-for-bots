// @ts-check
// M2 W2.8: SIGKILL at every step of the sealing protocol
// (designs/m2-interfaces.md 4.4, 4.5). The step runs in a child process
// (_m2-archive-kill-child.mjs) that SIGKILLs itself at the step; the fake
// session vat (_m2-archive-vat.js) then gets the answer (crank Z) or the
// retired break, a fresh incarnation starts over the same directories, and
// the test checks: nothing lost or duplicated (the context equals the
// oracle; history from the newest turn back to turn 1 shows every turn
// once), no `.part` file remains, only the segments the vat acknowledged
// remain, and the next seal succeeds.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execPath } from 'node:process';
import url from 'node:url';

import { makeFakeVat } from './_m2-archive-vat.js';
import {
  makeFakeSink,
  makeIncarnation,
  makeStateDir,
  oracleTranscript,
} from './_m2-archive.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

const CHILD = url.fileURLToPath(
  new URL('_m2-archive-kill-child.mjs', import.meta.url),
);

/**
 * A session grown until a seal is due (at least one segment already
 * sealed), its mirror flushed.
 * @param {number} seed
 */
const build = async seed => {
  const dirs = await makeStateDir('w28x');
  const { sink, keyOf } = makeFakeSink();
  const inc = makeIncarnation(dirs, sink);
  const vat = makeFakeVat({
    seed,
    store: inc.blobs,
    keepTurns: 6,
    segmentTurns: 3,
    stagedChance: 0.3,
  });
  const key = keyOf(vat.session);
  const port = inc.archive.portFor({ session: vat.session, key });
  const prepare = async (/** @type {any} */ req) => {
    await inc.cache.prepare(vat.session, req, { key });
  };
  while (vat.entries.length < 2) {
    // eslint-disable-next-line no-await-in-loop
    await vat.turn(prepare);
    // eslint-disable-next-line no-await-in-loop
    await vat.maybeSeal(port);
  }
  // One more turn so the mirror holds every record the next seal needs,
  // then grow until it is due.
  await vat.turn(prepare);
  while (vat.startSeal() === undefined) {
    // eslint-disable-next-line no-await-in-loop
    await vat.turn(prepare);
  }
  vat.notSealed();
  // The mirror's writes are queued: a read in the same queue waits for them.
  await inc.archive.tail(vat.session, key, { from: 0, until: 0 });
  return { dirs, sink, vat, key, inc, port };
};

/**
 * Run one step in a child that SIGKILLs itself at `killAt`.
 * @param {any} job
 * @param {string} dir
 */
const runChild = async (job, dir) => {
  const jobFile = join(dir, 'job.json');
  await writeFile(jobFile, JSON.stringify(job));
  const child = spawn(execPath, [CHILD, jobFile], {
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
  const line = out.split('\n').find(l => l.startsWith('{'));
  return {
    code,
    signal,
    answer: line === undefined ? undefined : JSON.parse(line),
    err,
  };
};

/** @param {string} dir */
const filesOf = async dir => {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
};

/**
 * After the kill: a fresh incarnation; check, then seal once more.
 * @param {import('ava').ExecutionContext} t
 * @param {Awaited<ReturnType<typeof build>>} built
 * @param {string} label
 */
const verify = async (t, built, label) => {
  const { dirs, sink, vat, key } = built;
  const dir = join(dirs.archiveDir, key);
  const inc = makeIncarnation(dirs, sink);
  await inc.archive.sweep();
  t.deepEqual(
    (await filesOf(dir)).filter(n => n.endsWith('.part') || n.endsWith('.tmp')),
    [],
    `${label}: no half-written file after the sweep`,
  );
  const oracle = async () => oracleTranscript(vat.all, inc.blobs);
  const projection = await inc.cache.prepare(
    vat.session,
    vat.request(`t-${label}`, 0),
    { key },
  );
  t.deepEqual(projection.transcript, await oracle(), `${label}: context`);
  const segments = (await filesOf(dir)).filter(n => n.startsWith('seg-'));
  t.is(segments.length, vat.entries.length, `${label}: acknowledged only`);
  // History from the newest turn back to turn 1: every turn once.
  /** @type {string[]} */
  const seen = [];
  /** @type {any} */
  let page = await E(inc.history).page(vat.session);
  for (;;) {
    seen.push(...page.turns.map((/** @type {any} */ turn) => turn.turnId));
    if (page.next === undefined) break;
    // eslint-disable-next-line no-await-in-loop
    page = await E(inc.history).page(vat.session, page.next);
  }
  t.deepEqual(
    seen,
    vat.turns.map(turn => turn.turnId).reverse(),
    `${label}: history`,
  );
  // The next seal succeeds.
  const port = inc.archive.portFor({ session: vat.session, key });
  const before = vat.entries.length;
  while (vat.entries.length === before) {
    // eslint-disable-next-line no-await-in-loop
    await vat.turn(async (/** @type {any} */ req) => {
      const p = await inc.cache.prepare(vat.session, req, { key });
      t.deepEqual(p.transcript, await oracle(), `${label}: after`);
    });
    // eslint-disable-next-line no-await-in-loop
    await vat.maybeSeal(port);
  }
  const last = await inc.cache.prepare(
    vat.session,
    vat.request(`t-${label}-z`, 0),
    { key },
  );
  t.deepEqual(last.transcript, await oracle(), `${label}: after the next seal`);
  return { segments: segments.length };
};

const SEAL_STEPS = [
  'a1',
  'write',
  'fsync',
  'rename',
  'fsync-dir',
  'manifest',
  'answer',
];

test('SIGKILL at every step of a seal (A1, A2, A3) loses and duplicates nothing', async t => {
  /** @type {any[]} */
  const rows = [];
  for (const [i, killAt] of SEAL_STEPS.entries()) {
    // eslint-disable-next-line no-await-in-loop
    const built = await build(31 + i);
    t.teardown(built.dirs.cleanup);
    const req = built.vat.startSeal();
    const { context: _context, ...plain } = /** @type {any} */ (req);
    // eslint-disable-next-line no-await-in-loop
    const run = await runChild(
      {
        action: 'seal',
        archiveDir: built.dirs.archiveDir,
        blobDir: built.dirs.blobDir,
        key: built.key,
        killAt,
        req: plain,
      },
      built.dirs.root,
    );
    t.is(run.signal, 'SIGKILL', `${killAt}: killed (${run.err.slice(0, 300)})`);
    t.is(run.answer, undefined, `${killAt}: never answered`);
    const dir = join(built.dirs.archiveDir, built.key);
    // eslint-disable-next-line no-await-in-loop
    const left = await filesOf(dir);
    // The restart delivers the retired break: not sealed.
    built.vat.notSealed();
    // eslint-disable-next-line no-await-in-loop
    const after = await verify(t, built, killAt);
    rows.push({
      killAt,
      parts: left.filter(n => n.endsWith('.part')).length,
      segmentFiles: left.filter(n => n.endsWith('.jsonl')).length,
      ...after,
    });
  }
  t.log(rows);
});

test('SIGKILL after the answer: sealed when the answer reaches the vat, an orphan when the break does', async t => {
  /** @type {any[]} */
  const rows = [];
  for (const [i, outcome] of /** @type {const} */ (['Z', 'break']).entries()) {
    // eslint-disable-next-line no-await-in-loop
    const built = await build(41 + i);
    t.teardown(built.dirs.cleanup);
    const req = built.vat.startSeal();
    const { context: _context, ...plain } = /** @type {any} */ (req);
    // eslint-disable-next-line no-await-in-loop
    const run = await runChild(
      {
        action: 'seal',
        archiveDir: built.dirs.archiveDir,
        blobDir: built.dirs.blobDir,
        key: built.key,
        killAt: 'after-answer',
        req: plain,
      },
      built.dirs.root,
    );
    t.is(run.signal, 'SIGKILL');
    t.truthy(run.answer, 'answered before the kill');
    const sealedBefore = built.vat.entries.length;
    if (outcome === 'Z') t.true(built.vat.sealed(run.answer));
    else built.vat.notSealed();
    // eslint-disable-next-line no-await-in-loop
    const after = await verify(t, built, `after-answer-${outcome}`);
    rows.push({ outcome, sealedBefore, ...after });
  }
  t.log(rows);
});

test('SIGKILL during the acknowledgment (A4): context and mirror catch up', async t => {
  /** @type {any[]} */
  const rows = [];
  for (const [i, killAt] of ['ack', 'context', 'mirror'].entries()) {
    // eslint-disable-next-line no-await-in-loop
    const built = await build(51 + i);
    t.teardown(built.dirs.cleanup);
    const req = built.vat.startSeal();
    // eslint-disable-next-line no-await-in-loop
    const answer = await E(built.port).seal(req);
    t.true(built.vat.sealed(answer));
    // eslint-disable-next-line no-await-in-loop
    const run = await runChild(
      {
        action: 'observe',
        archiveDir: built.dirs.archiveDir,
        blobDir: built.dirs.blobDir,
        key: built.key,
        killAt,
        state: built.vat.state(),
      },
      built.dirs.root,
    );
    t.is(run.signal, 'SIGKILL', `${killAt}: ${run.err.slice(0, 300)}`);
    // eslint-disable-next-line no-await-in-loop
    const after = await verify(t, built, `a4-${killAt}`);
    rows.push({ killAt, ...after });
  }
  t.log(rows);
});
