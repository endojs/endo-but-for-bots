// @ts-check

/**
 * The transport gives a worker up for a run of crashes, so what the engine
 * calls a crash decides which vats are given up on. A worker killed by a
 * signal, or one that misses its deadline, has crashed. One that exits with a
 * status has reported a failure of the host's and left in good order; one the
 * host terminated did as it was told. Neither may count against the worker.
 *
 * These drive the real engine and real processes against a stand-in for the
 * worker binary that ends however a frame tells it to.
 */
import { encodeBase64 } from '@endo/base64';
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkerCrashError } from '../src/core/worker-crash-error.js';
import { WorkerHaltError } from '../src/core/worker-engine.js';
import { makeIronhorseEngine } from '../src/ironhorse/ironhorse-engine.js';
import { makeNodePowers } from '../src/platform/node/powers.js';

/** @import { ExecutionContext } from 'ava' */

const nodePowers = makeNodePowers();
const workerBinary = fileURLToPath(
  new URL('./fixtures/ironhorse-stand-in-worker.cjs', import.meta.url),
);
const textEncoder = new TextEncoder();
/** @param {string} text a frame whose text tells the stand-in what to do */
const frame = text =>
  harden({ t: 'f', b64: encodeBase64(textEncoder.encode(text)) });

/**
 * @param {ExecutionContext} t
 * @param {number} [requestTimeoutMs]
 */
const makeKit = async (t, requestTimeoutMs = 30_000) => {
  t.timeout(60_000);
  const statePath = await mkdtemp('/tmp/thix-crash-class-');
  t.teardown(() => rm(statePath, { recursive: true, force: true }));
  const engine = makeIronhorseEngine(nodePowers, {
    workerBinary,
    bootPaths: [],
    storePath: join(statePath, 'heaps'),
    requestTimeoutMs,
  });
  const { acquireStore } = engine;
  if (acquireStore === undefined) throw Error('the engine owns no store');
  const release = await acquireStore(statePath);
  t.teardown(release);
  const start = () =>
    engine.start({ debugName: 'probe', snapshot: null, onOutbound: () => {} });
  /** @param {string} name how the next boot ends */
  const mark = name => writeFile(join(statePath, 'heaps', name), '');
  return { start, mark, statePath };
};

/**
 * @param {ExecutionContext} t
 * @param {() => Promise<unknown>} operation
 */
const crash = (t, operation) =>
  t.throwsAsync(operation, { instanceOf: WorkerCrashError });

/**
 * @param {ExecutionContext} t
 * @param {() => Promise<unknown>} operation
 * @param {RegExp} message
 */
const notCrash = async (t, operation, message) => {
  const error = await t.throwsAsync(operation, { message });
  t.false(error instanceof WorkerCrashError, `${error?.message} is no crash`);
};

test.serial(
  'a worker killed by a signal during a request has crashed',
  async t => {
    const { start } = await makeKit(t);
    const worker = await start();
    await worker.deliver(frame('fine'));
    const error = await crash(t, () => worker.deliver(frame('die-by-signal')));
    t.is(error?.message, 'Ironhorse worker exited (signaled)');
  },
);

test.serial(
  'a worker that exits with a status during a request has reported a failure, not crashed',
  async t => {
    const { start } = await makeKit(t);
    const worker = await start();
    await notCrash(
      t,
      () => worker.deliver(frame('exit-with-status')),
      /^Ironhorse worker exited \(1\)$/,
    );
  },
);

test.serial(
  'a worker that exits with a status before it is ready has not crashed',
  async t => {
    // This is how the worker refuses a lease, a heap or a disk: a fault of
    // the host's, which would otherwise give up every vat that tried to wake.
    const { start, mark } = await makeKit(t);
    await mark('boot-exits-with-status');
    await notCrash(t, start, /^Ironhorse worker exited \(1\)$/);
  },
);

test.serial(
  'a worker killed by a signal before it is ready has crashed',
  async t => {
    const { start, mark } = await makeKit(t);
    await mark('boot-dies-by-signal');
    await crash(t, start);
  },
);

test.serial(
  'a worker that misses its request deadline has crashed',
  async t => {
    // The deadline bounds the boot as well, and the stand-in boots a whole
    // Node process: it must be long enough for that on a busy machine.
    const { start } = await makeKit(t, 5000);
    const worker = await start();
    const error = await crash(t, () => worker.deliver(frame('hang')));
    t.is(error?.message, 'Ironhorse worker request timed out');
  },
);

test.serial(
  'an incarnation the host terminates mid-request has not crashed',
  async t => {
    const { start } = await makeKit(t);
    const worker = await start();
    const delivery = notCrash(
      t,
      () => worker.deliver(frame('hang')),
      /^Ironhorse worker exited \(signaled\)$/,
    );
    await worker.terminate();
    await delivery;
  },
);

test.serial(
  'a worker that died between requests fails the next one at once, as a crash',
  async t => {
    const { start } = await makeKit(t);
    const worker = await start();
    await worker.deliver(frame('die-idle'));
    // Long enough for the exit to be seen; far short of the deadline.
    await new Promise(resolve => setTimeout(resolve, 500));
    const began = Date.now();
    await crash(t, () => worker.deliver(frame('fine')));
    t.true(Date.now() - began < 5000, 'not left to run out the deadline');
  },
);

test.serial(
  'a worker killed in the middle of a reply has crashed, whichever of the cut reply and the exit is seen first',
  async t => {
    const { start } = await makeKit(t);
    const worker = await start();
    const error = await crash(t, () => worker.deliver(frame('die-mid-reply')));
    t.regex(String(error?.message), /^Ironhorse worker exited \(signaled\)/);
  },
);

test.serial(
  'a worker that dies while a large frame is being written to it has crashed, whichever of the broken pipe and the exit is seen first',
  async t => {
    const { start } = await makeKit(t);
    const worker = await start();
    await worker.deliver(frame('die-on-next-input'));
    // Larger than a pipe holds, so the write is still under way at the death.
    const large = frame(`fine ${'x'.repeat(4 * 1024 * 1024)}`);
    const error = await crash(t, () => worker.deliver(large));
    t.regex(String(error?.message), /^Ironhorse worker exited \(signaled\)/);
  },
);

test.serial('a worker that could not be started has not crashed', async t => {
  // The host's own failure: the engine's private copy of the binary is gone.
  const { start, statePath } = await makeKit(t);
  const runtime = join(statePath, 'runtime');
  const [profile] = await readdir(runtime);
  await rm(join(runtime, profile, '0'));
  await notCrash(t, start, /ENOENT/);
});

test.serial('a halt is a halt, whatever the exit that follows it', async t => {
  const { start } = await makeKit(t);
  const worker = await start();
  await t.throwsAsync(() => worker.deliver(frame('halt')), {
    instanceOf: WorkerHaltError,
    message: 'guest crank halted',
  });
});

test.serial(
  'the child a snapshot launches is judged for itself, not for the one it replaced',
  async t => {
    const { start } = await makeKit(t);
    const worker = await start();
    await worker.deliver(frame('fine'));
    // A snapshot closes the worker, which exits with status zero, and
    // launches another over the same heap.
    t.regex(String(await worker.snapshot()), /^[0-9a-f]{64}$/);
    await worker.deliver(frame('fine'));
    await worker.snapshot();
    await crash(t, () => worker.deliver(frame('die-by-signal')));
  },
);
