// @ts-check
// A state directory belongs to the engine that created it: with the real
// engines (the staged wasm launcher and its real parts, and the native
// worker), each engine writes a heap image and the other engine is refused
// the directory with the heap-format message, before anything in it, heaps
// included, changes.
import test from '@endo/ses-ava/test.js';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { makeIronhorseEngine } from '../../src/ironhorse/ironhorse-engine.js';
import { makeNodePowers } from '../../src/platform/node/powers.js';
import {
  BOOT_PATHS,
  NATIVE_WORKER,
  WASM_WORKER,
  sha256File,
  tempDir,
} from './_shell-harness.js';

/** @import { ExecutionContext } from 'ava' */

const nodePowers = makeNodePowers();

/**
 * Every file under `root`, by relative path, with its sha256.
 *
 * @param {string} root
 * @returns {Promise<Record<string, string>>}
 */
const tree = async root => {
  /** @type {Record<string, string>} */
  const files = {};
  /** @param {string} dir */
  const walk = async dir => {
    const entries = await readdir(dir);
    await Promise.all(
      entries.map(async name => {
        const path = join(dir, name);
        if ((await stat(path)).isDirectory()) {
          await walk(path);
        } else {
          files[relative(root, path)] = await sha256File(path);
        }
      }),
    );
  };
  await walk(root);
  return files;
};

/**
 * The Ironhorse engine always offers `acquireStore`, which the generic
 * engine type leaves optional.
 *
 * @param {ReturnType<typeof makeIronhorseEngine>} engine
 * @param {string} statePath
 */
const acquireStore = (engine, statePath) => {
  const { acquireStore: acquire } = engine;
  if (!acquire) throw Error('the Ironhorse engine acquires its store');
  return acquire(statePath);
};

/**
 * Acquire `statePath` with `workerBinary`, boot one worker, snapshot its
 * heap, and release everything. Answers the image's path.
 *
 * @param {ExecutionContext} t
 * @param {string} statePath
 * @param {string} workerBinary
 */
const writeHeapImage = async (t, statePath, workerBinary) => {
  const engine = makeIronhorseEngine(nodePowers, {
    workerBinary,
    bootPaths: [...BOOT_PATHS],
    storePath: join(statePath, 'heaps'),
  });
  const release = await acquireStore(engine, statePath);
  try {
    const worker = await engine.start({
      debugName: 'probe',
      snapshot: undefined,
      onOutbound: () => t.fail('no outbound expected'),
    });
    const ref = await worker.snapshot();
    await worker.terminate();
    return join(statePath, 'heaps', 'snapshots', `${ref}.sqlite`);
  } finally {
    await release();
  }
};

/**
 * @param {string} path
 * @returns {Promise<[number, number]>} the SQLite header's write and read
 *   versions: 1 for a rollback journal, 2 for WAL
 */
const journalVersions = async path => {
  const header = await readFile(path);
  return [header[18], header[19]];
};

for (const { first, second, firstFormat, secondFormat, versions } of [
  {
    first: NATIVE_WORKER,
    second: WASM_WORKER,
    firstFormat: 'native',
    secondFormat: 'do-v1',
    versions: [2, 2],
  },
  {
    first: WASM_WORKER,
    second: NATIVE_WORKER,
    firstFormat: 'do-v1',
    secondFormat: 'native',
    versions: [1, 1],
  },
]) {
  test.serial(
    `a state directory of ${firstFormat} heaps is refused to the ${secondFormat} engine`,
    async t => {
      t.timeout(180_000);
      const statePath = await tempDir(t, 'thix-wasm-mismatch-');
      const image = await writeHeapImage(t, statePath, first);
      t.deepEqual(await journalVersions(image), versions);
      const before = await tree(statePath);

      const engine = makeIronhorseEngine(nodePowers, {
        workerBinary: second,
        bootPaths: [...BOOT_PATHS],
        storePath: join(statePath, 'heaps'),
      });
      await t.throwsAsync(() => acquireStore(engine, statePath), {
        message: new RegExp(
          `^Incompatible Ironhorse runtime: the state directory holds "${firstFormat}" heaps and this worker uses "${secondFormat}" heaps; `,
        ),
      });
      t.deepEqual(await tree(statePath), before, 'nothing changed');

      // The engine that wrote the directory still owns it.
      const again = await writeHeapImage(t, statePath, first);
      t.true(again.endsWith('.sqlite'));
    },
  );
}
