// @ts-check
// How the wasm engine's Node shell fails, and what it leaves on disk when it
// does: a boot that fails, a heap file that is not this engine's, and a
// worker killed before or during a crank.
import test from '@endo/ses-ava/test.js';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  NATIVE_WORKER,
  READY,
  WASM_WORKER,
  limitsJson,
  line,
  result,
  runWorker,
  sha256File,
  startWorker,
  tempDir,
} from './_shell-harness.js';

/** @import { ExecutionContext } from 'ava' */

/** @param {number} ms */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** @param {string} text */
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const { title, source, limits } of [
  {
    title: 'a boot file that throws',
    source: "throw Error('this boot is refused');",
    limits: limitsJson(),
  },
  {
    title: 'a boot file that runs past the bootstrap budget',
    source: 'for (;;) {}',
    limits: limitsJson({ bootstrapBudget: '5000000' }),
  },
]) {
  test.serial(
    `${title} leaves no heap, and the next start boots fresh`,
    async t => {
      t.timeout(180_000);
      const dir = await tempDir(t);
      const boot = join(dir, 'bad-boot.js');
      await writeFile(boot, source);
      const heap = join(dir, 'heap.sqlite');
      const failed = await runWorker(t, WASM_WORKER, dir, heap, [], {
        boots: [boot],
        limits,
      });
      t.is(failed.code, 1);
      t.deepEqual(failed.lines, [], 'no ready line');
      t.regex(
        failed.stderr,
        new RegExp(`^worker failed: boot ${escape(boot)}: .+\n$`),
      );
      t.false(existsSync(heap), 'the unbooted heap is removed');
      t.false(existsSync(`${heap}-journal`), 'and its journal');
      t.deepEqual((await readdir(dir)).sort(), ['bad-boot.js', 'lease']);

      const booted = await runWorker(t, WASM_WORKER, dir, heap, [
        line({ source: 'globalThis.afterBoot = 6 * 7' }),
      ]);
      t.is(booted.code, 0, booted.stderr);
      t.deepEqual(booted.lines, [READY, result('42')]);
      const resumed = await runWorker(t, WASM_WORKER, dir, heap, [
        line({ source: 'afterBoot' }),
      ]);
      t.deepEqual(resumed.lines, [READY, result('42')]);
    },
  );
}

test.serial(
  'heap files of another kind are refused and left untouched',
  async t => {
    t.timeout(180_000);
    const dir = await tempDir(t);

    const nativeHeap = join(dir, 'native.sqlite');
    const native = await runWorker(t, NATIVE_WORKER, dir, nativeHeap, [
      line({ source: 'globalThis.native = 1' }),
    ]);
    t.is(native.code, 0, native.stderr);

    const otherDatabase = join(dir, 'other.sqlite');
    const db = new DatabaseSync(otherDatabase);
    db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
    db.exec("INSERT INTO notes (body) VALUES ('not a heap')");
    db.close();

    const garbage = join(dir, 'garbage.sqlite');
    await writeFile(garbage, randomBytes(8192));

    for (const [heap, refusal] of [
      [nativeHeap, /in WAL mode, which this engine never writes/],
      [otherDatabase, /without the wasm Ironhorse worker's stamp/],
      [garbage, /is not an SQLite database/],
    ]) {
      const path = /** @type {string} */ (heap);
      // eslint-disable-next-line no-await-in-loop
      const before = await sha256File(path);
      // eslint-disable-next-line no-await-in-loop
      const entries = (await readdir(dir)).sort();
      // eslint-disable-next-line no-await-in-loop
      const run = await runWorker(t, WASM_WORKER, dir, path, [
        line({ source: '1' }),
      ]);
      t.is(run.code, 1, path);
      t.deepEqual(run.lines, [], path);
      t.regex(
        run.stderr,
        new RegExp(
          `^worker failed: heap file ${escape(path)} .*${/** @type {RegExp} */ (refusal).source}.*; refusing to open it\n$`,
        ),
      );
      // eslint-disable-next-line no-await-in-loop
      const after = await sha256File(path);
      t.is(after, before, `${path} is byte for byte unchanged`);
      // eslint-disable-next-line no-await-in-loop
      t.deepEqual((await readdir(dir)).sort(), entries, 'no file appeared');
    }
    // The native worker still opens its own heap.
    const again = await runWorker(t, NATIVE_WORKER, dir, nativeHeap, [
      line({ source: 'native' }),
    ]);
    t.deepEqual(again.lines, [READY, result('1')]);
  },
);

/**
 * Start a worker over `heap`, wait for ready, send `request`, and SIGKILL it
 * once `settle` resolves.
 *
 * @param {ExecutionContext} t
 * @param {string} dir
 * @param {string} heap
 * @param {string} request
 * @param {(worker: ReturnType<typeof startWorker>) => Promise<unknown>} settle
 */
const killDuring = async (t, dir, heap, request, settle) => {
  const worker = startWorker(t, WASM_WORKER, {
    heap,
    lease: join(dir, 'lease'),
    // A crank that cannot run out of budget before it is killed.
    limits: limitsJson({ crankBudget: '1000000000000000' }),
  });
  await worker.waitForLines(1);
  worker.child.stdin?.write(`${request}\n`);
  await settle(worker);
  t.is(worker.child.exitCode, null, 'killed while still running');
  worker.child.kill('SIGKILL');
  const { signal } = await worker.exited;
  t.is(signal, 'SIGKILL');
};

test.serial('a worker killed mid-crank reopens at its last commit', async t => {
  t.timeout(180_000);
  const dir = await tempDir(t);
  const heap = join(dir, 'heap.sqlite');
  const loop = line({ source: 'globalThis.kept = 2; for (;;) {}' });

  // The last commit is the boot's.
  await killDuring(t, dir, heap, loop, () => delay(1500));
  t.false(existsSync(`${heap}-journal`), 'a crank leaves no journal');
  const booted = await runWorker(t, WASM_WORKER, dir, heap, [
    line({ source: 'typeof kept' }),
    line({ source: 'globalThis.kept = 1' }),
  ]);
  t.is(booted.code, 0, booted.stderr);
  t.deepEqual(booted.lines, [READY, result('undefined'), result('1')]);

  // The last commit is that run's close.
  await killDuring(t, dir, heap, loop, () => delay(1500));
  t.false(existsSync(`${heap}-journal`));
  const closed = await runWorker(t, WASM_WORKER, dir, heap, [
    line({ source: 'kept' }),
  ]);
  t.is(closed.code, 0, closed.stderr);
  t.deepEqual(closed.lines, [READY, result('1')]);
});

test.serial('answered cranks are not durable until close', async t => {
  // By design: a crank commits at close, not when it is answered. The host
  // never resumes an abandoned incarnation's heap; it restarts from the
  // last snapshot and replays the deliveries since from its own journal.
  // A worker killed after answering, before close, therefore resumes
  // without those cranks. Do not "fix" this by committing per request.
  t.timeout(180_000);
  const dir = await tempDir(t);
  const heap = join(dir, 'heap.sqlite');
  const first = await runWorker(t, WASM_WORKER, dir, heap, [
    line({ source: 'globalThis.answered = 1' }),
  ]);
  t.deepEqual(first.lines, [READY, result('1')]);

  await killDuring(t, dir, heap, line({ source: 'answered = 2' }), worker =>
    worker.waitForLines(2),
  );
  const resumed = await runWorker(t, WASM_WORKER, dir, heap, [
    line({ source: 'answered' }),
  ]);
  t.is(resumed.code, 0, resumed.stderr);
  t.deepEqual(resumed.lines, [READY, result('1')]);
});
