// @ts-check
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';

import {
  makeIronhorseLimits,
  readIronhorseLimits,
} from '../src/ironhorse/ironhorse-limits.js';
import { acquireIronhorseRuntime } from '../src/ironhorse/ironhorse-runtime.js';
import { makeHashPowers } from '../src/platform/hashes.js';

/** @import { ExecutionContext } from 'ava' */
/** @import { FilePowers } from '../src/platform/files.js' */
/** @import { PathPowers } from '../src/platform/paths.js' */
/** @import { ProcessPowers } from '../src/platform/processes.js' */

test('Ironhorse configuration preserves wide budgets without numeric rounding', t => {
  const limits = readIronhorseLimits({
    get: name =>
      ({
        THIXOTROPE_CRANK_BUDGET: '9007199254740993',
        THIXOTROPE_BOOTSTRAP_BUDGET: '18446744073709551615',
        THIXOTROPE_SLOT_CEILING: '2000000',
        THIXOTROPE_CHUNK_CEILING: '536870912',
        THIXOTROPE_REQUEST_TIMEOUT_MS: '90000',
      })[name],
  });
  t.deepEqual(limits, {
    crankBudget: '9007199254740993',
    bootstrapBudget: '18446744073709551615',
    slotCeiling: 2_000_000,
    chunkCeiling: 536_870_912,
    requestTimeoutMs: 90_000,
  });
  t.is(
    makeIronhorseLimits({ crankBudget: 9_007_199_254_740_993n }).crankBudget,
    limits.crankBudget,
  );
});

test('Ironhorse configuration rejects unsupported quantities rather than clamping', t => {
  for (const options of [
    { crankBudget: 0 },
    { crankBudget: '18446744073709551616' },
    { crankBudget: 9_007_199_254_740_992 },
    { bootstrapBudget: 'unlimited' },
    { slotCeiling: '4294967296' },
    { chunkCeiling: -1 },
    { requestTimeoutMs: 2_147_483_648 },
    { requestTimeoutMs: 1.5 },
  ]) {
    t.throws(() => makeIronhorseLimits(options), { message: /must be/ });
  }
});

// The runtime manifest policy is exercised against an in-memory host: a fake
// lock supervisor that speaks the ownership protocol and a fake file system.
// The Rust worker is never spawned here; test/ironhorse/limits.js covers the
// same policy end to end with a built worker.

const statePath = 'state';
const workerBinary = 'bin/worker';
const bootPaths = harden(['boot/main.js']);
const manifestPath = `${statePath}/runtime.json`;

const unused = () => {
  throw Error('unused by the runtime under test');
};

/** @param {string} path */
const enoent = path =>
  Object.assign(Error(`ENOENT: ${path}`), { code: 'ENOENT' });

const makeFakeHost = () => {
  /** @type {Map<string, string>} */
  const texts = new Map([
    [workerBinary, 'worker bytes'],
    [bootPaths[0], 'bootstrap bytes'],
  ]);
  /** @type {Set<string>} */
  const directories = new Set();
  /** @param {string} path */
  const read = path => {
    const text = texts.get(path);
    if (text === undefined) throw enoent(path);
    return text;
  };
  /** @type {FilePowers} */
  const files = {
    readText: async path => read(path),
    readBytes: unused,
    readChunks: async function* readChunks(path) {
      yield new TextEncoder().encode(read(path));
    },
    writeTextAtomic: async (path, text) => {
      texts.set(path, text);
    },
    makeDirectory: async path => {
      directories.add(path);
    },
    makeTempDirectory: unused,
    listDirectory: async path => {
      if (!directories.has(path)) throw enoent(path);
      const prefix = `${path}/`;
      const names = [...texts.keys(), ...directories]
        .filter(entry => entry.startsWith(prefix))
        .map(entry => entry.slice(prefix.length).split('/')[0]);
      return [...new Set(names)];
    },
    rename: async (from, to) => {
      texts.set(to, read(from));
      texts.delete(from);
    },
    remove: async path => {
      texts.delete(path);
    },
    copyFile: async (from, to) => {
      texts.set(to, read(from));
    },
    realPath: unused,
    stat: unused,
    chmod: unused,
    open: async () => ({
      fd: undefined,
      writeText: async () => {},
      sync: async () => {},
      close: async () => {},
    }),
    syncPath: async () => {},
  };
  /** @type {ProcessPowers} */
  const processes = {
    spawn: () => {
      const queue = ['{"op":"locked"}'];
      let ended = false;
      /** @type {(() => void) | undefined} */
      let wake;
      /** @type {(code: number) => void} */
      let exit = () => {};
      /** @type {Promise<number | null>} */
      const exited = new Promise(resolve => {
        exit = resolve;
      });
      const notify = () => {
        const waiter = wake;
        wake = undefined;
        waiter?.();
      };
      async function* lines() {
        await null;
        for (;;) {
          const line = queue.shift();
          if (line !== undefined) {
            yield line;
          } else if (ended) {
            return;
          } else {
            // eslint-disable-next-line no-await-in-loop
            await new Promise(resolve => {
              wake = () => resolve(undefined);
            });
          }
        }
      }
      return {
        pid: 1,
        lines,
        input: () => ({
          write: text => {
            if (text === 'prepare\n') queue.push('{"op":"ready"}');
            notify();
          },
          end: () => {
            ended = true;
            notify();
            exit(0);
          },
        }),
        exited,
        failed: new Promise(() => {}),
        kill: () => {},
      };
    },
  };
  /** @type {PathPowers} */
  const paths = {
    join: (...parts) => parts.join('/'),
    dirname: unused,
    resolve: unused,
    isAbsolute: unused,
    fileURLToPath: unused,
    pathToFileURL: unused,
  };
  const hashes = makeHashPowers({ files });
  return harden({ powers: { processes, files, paths, hashes }, texts });
};

/**
 * Acquire and immediately release the runtime, returning the parsed manifest.
 * @param {ExecutionContext} t
 * @param {ReturnType<typeof makeFakeHost>} host
 * @param {Parameters<typeof makeIronhorseLimits>[0]} options
 */
const acquire = async (t, host, options) => {
  const runtime = await acquireIronhorseRuntime(host.powers, {
    statePath,
    workerBinary,
    bootPaths: [...bootPaths],
    limits: makeIronhorseLimits(options),
    onLost: () => t.fail('Ironhorse ownership lost unexpectedly'),
  });
  await runtime.release();
  return JSON.parse(host.texts.get(manifestPath) ?? '');
};

const defaultLimits = harden({
  crankBudget: '10000000',
  bootstrapBudget: '1000000000',
  slotCeiling: 1_000_000,
  chunkCeiling: 268_435_456,
});

test('Ironhorse runtime records execution limits beside the pinned identity', async t => {
  const host = makeFakeHost();
  const manifest = await acquire(t, host, { requestTimeoutMs: 5 });
  t.is(manifest.format, 2);
  t.is(manifest.hostProtocol, 'sequenced-hub-outbox-v1');
  t.is(typeof manifest.worker, 'string');
  t.is(manifest.bootstrap.length, 1);
  // The watchdog is operational, not part of the persisted profile.
  t.deepEqual(manifest.limits, defaultLimits);
  t.deepEqual(await acquire(t, host, { requestTimeoutMs: 6 }), manifest);
});

test('Ironhorse budgets may change in either direction across restart', async t => {
  const host = makeFakeHost();
  const raised = await acquire(t, host, {
    crankBudget: 30_000_000n,
    bootstrapBudget: '2000000000',
  });
  t.like(raised.limits, {
    crankBudget: '30000000',
    bootstrapBudget: '2000000000',
  });
  // Tuning back down, including to the defaults by omission, is accepted and
  // recorded: budgets meter each crank afresh and cannot invalidate a heap.
  const lowered = await acquire(t, host, { crankBudget: 20_000_000 });
  t.deepEqual(lowered.limits, { ...defaultLimits, crankBudget: '20000000' });
  t.deepEqual((await acquire(t, host, {})).limits, defaultLimits);
});

test('Ironhorse heap ceilings refuse to decrease below the persisted value', async t => {
  const host = makeFakeHost();
  const raised = await acquire(t, host, {
    slotCeiling: 1_500_000,
    chunkCeiling: 400_000_000,
  });
  t.like(raised.limits, { slotCeiling: 1_500_000, chunkCeiling: 400_000_000 });
  const before = host.texts.get(manifestPath);
  for (const [options, name] of /** @type {const} */ ([
    [{ slotCeiling: 1_200_000, chunkCeiling: 400_000_000 }, 'slotCeiling'],
    [{ slotCeiling: 1_500_000, chunkCeiling: 300_000_000 }, 'chunkCeiling'],
    // Omitting a raised ceiling selects the default, which is a decrease.
    [{ chunkCeiling: 400_000_000 }, 'slotCeiling'],
  ])) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => acquire(t, host, options), {
      message: new RegExp(
        `^Incompatible Ironhorse runtime: ${name} cannot decrease below persisted value`,
      ),
    });
    t.is(host.texts.get(manifestPath), before);
  }
  // A further increase is accepted; a lower budget alongside it is too.
  const wider = await acquire(t, host, {
    crankBudget: 1,
    slotCeiling: 1_600_000,
    chunkCeiling: 400_000_000,
  });
  t.deepEqual(wider.limits, {
    ...defaultLimits,
    crankBudget: '1',
    slotCeiling: 1_600_000,
    chunkCeiling: 400_000_000,
  });
});

test('Ironhorse manifest comparison does not depend on key order', async t => {
  const host = makeFakeHost();
  const manifest = await acquire(t, host, { slotCeiling: 1_500_000 });
  /** @param {Record<string, unknown>} record */
  const reversed = record =>
    Object.fromEntries(Object.entries(record).reverse());
  const reordered = JSON.stringify({
    ...reversed(manifest),
    limits: reversed(manifest.limits),
  });
  t.not(reordered, JSON.stringify(manifest));
  host.texts.set(manifestPath, reordered);
  t.deepEqual(await acquire(t, host, { slotCeiling: 1_500_000 }), manifest);
  // The ceiling rule still applies to the reordered manifest.
  host.texts.set(manifestPath, reordered);
  await t.throwsAsync(() => acquire(t, host, {}), {
    message: /slotCeiling cannot decrease below persisted value 1500000/,
  });
});

test('Ironhorse distinguishes a newer manifest from an incompatible or invalid one', async t => {
  const host = makeFakeHost();
  const manifest = await acquire(t, host, {});
  /** @param {unknown} value */
  const write = value => host.texts.set(manifestPath, JSON.stringify(value));
  write({ ...manifest, format: 3 });
  await t.throwsAsync(() => acquire(t, host, {}), {
    message: /newer version: manifest format 3 exceeds supported format 2/,
  });
  write({ ...manifest, limits: { ...manifest.limits, stackCeiling: 1 } });
  await t.throwsAsync(() => acquire(t, host, {}), {
    message: /newer version: unrecognized execution limit "stackCeiling"/,
  });
  write({ ...manifest, attestation: 'x' });
  await t.throwsAsync(() => acquire(t, host, {}), {
    message: /newer version: unrecognized manifest field "attestation"/,
  });
  // An older format or a different runtime is incompatible, not newer.
  const incompatible = /^Incompatible Ironhorse runtime: worker, bootstrap/;
  write({ ...manifest, format: 1, extra: true });
  await t.throwsAsync(() => acquire(t, host, {}), { message: incompatible });
  write({ ...manifest, worker: 'other' });
  await t.throwsAsync(() => acquire(t, host, {}), { message: incompatible });
  write({ ...manifest, bootstrap: [] });
  await t.throwsAsync(() => acquire(t, host, {}), { message: incompatible });
  // Damaged limits are invalid, not newer.
  const { limits: _limits, ...withoutLimits } = manifest;
  write(withoutLimits);
  await t.throwsAsync(() => acquire(t, host, {}), {
    message: /^Missing Ironhorse execution limits/,
  });
  write({ ...manifest, limits: { ...manifest.limits, crankBudget: 0 } });
  await t.throwsAsync(() => acquire(t, host, {}), {
    message:
      /^Invalid Ironhorse execution limits in runtime\.json: crankBudget/,
  });
  write({
    ...manifest,
    limits: { ...manifest.limits, slotCeiling: '1000000' },
  });
  await t.throwsAsync(() => acquire(t, host, {}), {
    message:
      /^Invalid Ironhorse execution limits in runtime\.json: slotCeiling/,
  });
  write([]);
  await t.throwsAsync(() => acquire(t, host, {}), {
    message: /^Invalid Ironhorse runtime\.json/,
  });
  // Every refusal leaves the manifest untouched.
  t.is(host.texts.get(manifestPath), '[]');
});
