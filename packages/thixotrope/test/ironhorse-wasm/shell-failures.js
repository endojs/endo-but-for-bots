// @ts-check
// How the wasm engine's Node shell fails, and what it leaves on disk when it
// does: a boot that fails or is killed, a heap file that is not this
// engine's, a module that does not compile, a heap path that cannot be
// created, and a worker killed before or during a crank.
import test from '@endo/ses-ava/test.js';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openHeapDatabase } from '../../src/ironhorse/wasm/shell.mjs';

import {
  BOOT_PATHS,
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

test.serial(
  'a fresh worker killed during its boot never resumes an unbooted heap',
  async t => {
    // The fresh open, every boot file and ready are one transaction. A
    // worker killed anywhere inside it must not leave a heap that a later
    // start serves: today such a file is refused (exit 1), and a start
    // after the commit finds a booted machine. Committing the open on its
    // own would leave the bare machine, which a restart would answer ready
    // over without `thixotropeDispatch`.
    t.timeout(600_000);
    const dir = await tempDir(t);
    const slow = join(dir, 'slow-boot.js');
    await writeFile(
      slow,
      'var slowSum = 0; for (var i = 0; i < 2000000; i++) slowSum += i; globalThis.slowBooted = true;',
    );
    const boots = [...BOOT_PATHS, slow];
    const probe = line({
      source: "typeof slowBooted + ' ' + typeof thixotropeDispatch",
    });
    /** @type {Record<string, number>} */
    const outcomes = { absent: 0, refused: 0, booted: 0 };
    // From before the database exists, through the SES boot and the slow
    // file, to around the commit and after ready.
    for (const ms of [100, 400, 900, 1500, 2200, 3000, 3800, 4600, 6000]) {
      const heap = join(dir, `heap-${ms}.sqlite`);
      const worker = startWorker(t, WASM_WORKER, {
        heap,
        lease: join(dir, 'lease'),
        boots,
      });
      // eslint-disable-next-line no-await-in-loop
      await delay(ms);
      worker.child.kill('SIGKILL');
      // eslint-disable-next-line no-await-in-loop
      await worker.exited;
      const restart = existsSync(heap)
        ? // eslint-disable-next-line no-await-in-loop
          await runWorker(t, WASM_WORKER, dir, heap, [probe], { boots })
        : undefined;
      if (restart === undefined) {
        outcomes.absent += 1;
      } else if (restart.lines.length === 0) {
        outcomes.refused += 1;
        t.is(restart.code, 1, `${ms} ms`);
        t.regex(restart.stderr, /^worker failed: [^\n]+\n$/, `${ms} ms`);
      } else {
        outcomes.booted += 1;
        t.deepEqual(
          restart.lines,
          [READY, result('boolean function')],
          `${ms} ms: a ready line only over a booted machine`,
        );
      }
    }
    t.log(outcomes);
    t.true(outcomes.refused > 0, 'some kill fell inside the boot');
  },
);

test.serial(
  'a module that does not compile is one failure line and no heap',
  async t => {
    t.timeout(60_000);
    const dir = await tempDir(t);
    const stage = join(dir, 'stage');
    await mkdir(stage);
    const staged = dirname(WASM_WORKER);
    for (const name of [
      basename(WASM_WORKER),
      'thixotrope-ironhorse-wasm-shell.mjs',
      'host-abi.mjs',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await copyFile(join(staged, name), join(stage, name));
    }
    const wasm = await readFile(join(staged, 'thixotrope_ironhorse_wasm.wasm'));
    await writeFile(
      join(stage, 'thixotrope_ironhorse_wasm.wasm'),
      wasm.subarray(0, Math.trunc(wasm.length / 2)),
    );
    const heap = join(dir, 'heap.sqlite');
    const run = await runWorker(
      t,
      join(stage, basename(WASM_WORKER)),
      dir,
      heap,
      [line({ source: '1' })],
    );
    t.is(run.code, 1);
    t.deepEqual(run.lines, []);
    t.regex(
      run.stderr,
      /^worker failed: Node v\S+ cannot compile the worker module \(it needs WebAssembly exception handling with exnref\): [^\n]+\n$/,
    );
    t.false(existsSync(heap));
  },
);

test.serial(
  'a heap path that cannot be created is one failure line',
  async t => {
    t.timeout(60_000);
    const dir = await tempDir(t);
    // The parent is a regular file, so both the open and the removal of
    // the unbooted heap fail (ENOTDIR).
    await writeFile(join(dir, 'file'), '');
    const run = await runWorker(
      t,
      WASM_WORKER,
      dir,
      join(dir, 'file', 'heap.sqlite'),
      [],
    );
    t.is(run.code, 1);
    t.deepEqual(run.lines, []);
    t.regex(run.stderr, /^worker failed: [^\n]+\n$/);
    t.notRegex(run.stderr, /\n {4}at /, 'no stack trace');
  },
);

test.serial(
  'a heap is opened in rollback-journal mode, fully synced',
  async t => {
    const dir = await tempDir(t);
    const db = openHeapDatabase(DatabaseSync, join(dir, 'heap.sqlite'));
    t.teardown(() => db.close());
    t.is(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
    // FULL is 2.
    t.is(db.prepare('PRAGMA synchronous').get()?.synchronous, 2);
  },
);
