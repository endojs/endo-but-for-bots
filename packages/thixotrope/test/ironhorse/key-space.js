// @ts-check
// A vat's property-key table (16-bit ids, never reclaimed) through a real
// Ironhorse worker:
//
// - Inbound frames do not consume it. SES `harden` copies each frame's
//   descriptors, and `Object.getOwnPropertyDescriptors` used to name every
//   byte index, so a vat kept one key per byte of the largest frame it had
//   received and halted near 58 KB.
// - When guest data does exhaust it while the OCapN pump decodes a frame
//   (a record with fresh keys), the worker halts and the host breaks the
//   answer, rather than leaving a vat that is awake but never answers.
import { E } from '@endo/eventual-send';
import harden from '@endo/harden';
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

const RETIRED = 'ocapn hub: the target session has been retired';

/** @param {import('ava').ExecutionContext} t */
const makeVat = async t => {
  const statePath = await mkdtemp(join(tmpdir(), 'thix-keys-'));
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
    // These tests send frames of up to 50,000 bytes into the vat, above the
    // hub's default ceiling, to show what the vat itself does with them.
    vatFrameBytes: 65_536,
  });
  const vat = await daemon.createWorker({ debugLabel: 'key-space' });
  return vat.evaluate(`Far('keys', {
    room: () => {
      const o = {};
      let i = 0;
      try {
        for (;; i += 1) o['room' + i] = 1;
      } catch (e) {
        return [i, e.message].join('|');
      }
    },
    len: s => s.length,
    count: r => Object.keys(r).length,
    ping: () => 'pong',
  })`);
};

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 */
const within = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error(`no answer in ${ms} ms`)), ms),
    ),
  ]);

test.serial('inbound frames leave the key table alone', async t => {
  t.timeout(180_000);
  const keys = await makeVat(t);
  // Twice S1's frameBytes, then the old 10 M halt point's neighbourhood.
  for (const size of [49_152, 49_152, 50_000]) {
    // eslint-disable-next-line no-await-in-loop
    t.is(await E(keys).len('a'.repeat(size)), size);
  }
  const [room, why] = (await E(keys).room()).split('|');
  t.is(why, 'property key space exhausted');
  // A fresh vat has about 57 k; before the fix this read about 8 k.
  t.true(Number(room) > 50_000, `room for ${room} names`);
});

test.serial(
  'a record that exhausts the key table retires the vat instead of wedging it',
  async t => {
    t.timeout(180_000);
    const keys = await makeVat(t);
    t.is(await E(keys).ping(), 'pong');
    // The guest fills the table up to the engine's reserve and catches the
    // RangeError: the vat is still healthy and answers.
    t.regex(await E(keys).room(), /\|property key space exhausted$/);
    t.is(await E(keys).ping(), 'pong');
    // The pump now fails to decode a record with 2,000 fresh keys.
    const record = harden(
      Object.fromEntries(
        Array.from({ length: 2000 }, (_, i) => [`fresh${i}`, true]),
      ),
    );
    await t.throwsAsync(within(E(keys).count(record), 60_000), {
      message: RETIRED,
    });
    await t.throwsAsync(within(E(keys).ping(), 60_000), { message: RETIRED });
  },
);
