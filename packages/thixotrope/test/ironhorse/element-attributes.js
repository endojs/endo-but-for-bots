// @ts-check
// Array elements created from `const` bindings, through a real Ironhorse
// worker (harness core candidate C-16).
//
// The engine pushed a `const` binding's scope slot onto the value stack
// with its read-only flag, and `Array.prototype.push` (and `a[i] = v`,
// `o[i] = v`, `unshift`, `fill`, ...) kept that flag on the element it
// created: `const x = {}; a.push(x)` made element 0 writable false,
// configurable true, so a later `splice` threw "set ?: not writable". The
// harness's session queue met it as an entry that could never be claimed.
// Here the push and the splice run in separate cranks, with a sleep (a
// snapshot and a restore) between them, as a vat's queue does.
import { E } from '@endo/eventual-send';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { syrupCodec } from '@endo/ocapn/syrup';
import test from '@endo/ses-ava/test.js';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeThixotropeDaemon } from '../../src/core/daemon.js';
import { makeIronhorseEngine } from '../../src/ironhorse/ironhorse-engine.js';
import { makeFsStore } from '../../src/store/store-fs.js';
import { makeNodePowers } from '../../src/platform/node/powers.js';

const powers = makeNodePowers();
const packagePath = fileURLToPath(new URL('../../', import.meta.url));
const workerBinary =
  process.env.THIXOTROPE_IRONHORSE_WORKER ??
  join(packagePath, '../../target/release/thixotrope-ironhorse-worker');
const bootDir =
  process.env.THIXOTROPE_BOOT_DIR ?? join(packagePath, 'dist-ironhorse');
const bootPaths = ['boot.js', 'worker-peer.js'].map(name =>
  join(bootDir, name),
);
await Promise.all([workerBinary, ...bootPaths].map(path => access(path)));

// The queue's shape before the harness's workaround: entries are `const`
// locals that no closure captures, pushed onto a module-level array and
// later spliced out of it.
const QUEUE_SOURCE = `(() => {
  const waiting = [];
  const byIndex = {};
  let next = 0;
  const attrs = value => Reflect.ownKeys(value).map(key => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return String(key) + ':' + (d.writable ? 'w' : '-') +
      (d.enumerable ? 'e' : '-') + (d.configurable ? 'c' : '-');
  }).join(' ');
  return Far('queue', {
    enqueue: text => {
      const internal = { text, key: 'q' + next };
      waiting.push(internal);
      byIndex[next] = internal;
      next += 1;
      harden(internal);
      return waiting.length;
    },
    claimFirst: () => {
      const internal = waiting[0];
      waiting.splice(0, 1);
      return internal.text;
    },
    shiftThenWrite: () => {
      waiting.shift();
      byIndex[0] = 'claimed';
      return waiting.length;
    },
    attributes: () => attrs(waiting) + ' | ' + attrs(byIndex),
  });
})()`;

/** @param {import('ava').ExecutionContext} t */
const makeVat = async t => {
  const statePath = await mkdtemp(join(tmpdir(), 'thix-elements-'));
  /** @type {Awaited<ReturnType<typeof makeThixotropeDaemon>> | undefined} */
  let daemon;
  t.teardown(async () => {
    try {
      await daemon?.crash();
    } finally {
      await rm(statePath, { recursive: true, force: true });
    }
  });
  daemon = await makeThixotropeDaemon(powers, {
    store: makeFsStore(powers, statePath),
    engine: makeIronhorseEngine(powers, {
      workerBinary,
      bootPaths,
      storePath: join(statePath, 'heaps'),
    }),
    codec: syrupCodec,
    makeNetlayer: ({ handlers, logger }) =>
      makeTcpNetLayer({ handlers, logger }),
  });
  const worker = await daemon.createWorker({ debugLabel: 'elements' });
  const queue = await worker.evaluate(QUEUE_SOURCE);
  return { worker, queue };
};

test.serial(
  'elements pushed from const bindings stay writable across cranks and a sleep',
  async t => {
    t.timeout(180_000);
    const { worker, queue } = await makeVat(t);
    t.is(await E(queue).enqueue('fifo 1'), 1);
    t.is(await E(queue).enqueue('fifo 2'), 2);
    t.is(await E(queue).enqueue('fifo 3'), 3);
    t.is(
      await E(queue).attributes(),
      '0:wec 1:wec 2:wec length:w-- | 0:wec 1:wec 2:wec',
    );
    await worker.sleep();
    t.false(worker.isAwake());
    // FIFO: each claim removes the head (J-0271 ran 'fifo 1' three times).
    t.is(await E(queue).claimFirst(), 'fifo 1');
    t.is(await E(queue).claimFirst(), 'fifo 2');
    t.is(await E(queue).enqueue('fifo 4'), 2);
    await worker.sleep();
    t.is(await E(queue).shiftThenWrite(), 1);
    t.is(await E(queue).claimFirst(), 'fifo 4');
    t.is(await E(queue).attributes(), 'length:w-- | 0:wec 1:wec 2:wec 3:wec');
  },
);
