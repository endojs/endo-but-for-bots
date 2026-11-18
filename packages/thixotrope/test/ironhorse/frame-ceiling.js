// @ts-check
// The hub's frame ceiling in front of a real Ironhorse vat: a call from an
// adapter-kind session (a disposable host client) that is too large for the
// vat to decode is refused at the hub. The vat's journal does not grow, the
// vat does not halt, and it still serves.
import { E } from '@endo/eventual-send';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { syrupCodec } from '@endo/ocapn/syrup';
import test from '@endo/ses-ava/test.js';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_VAT_FRAME_BYTES,
  makeThixotropeDaemon,
} from '../../src/core/daemon.js';
import { makeIronhorseEngine } from '../../src/ironhorse/ironhorse-engine.js';
import { FRAME_TOO_LARGE } from '../../src/net/hub.js';
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

test.serial(
  'an oversized call from an adapter session is refused before the vat',
  async t => {
    t.timeout(120_000);
    const statePath = await mkdtemp(join(tmpdir(), 'thix-frames-'));
    /** @type {Awaited<ReturnType<typeof makeThixotropeDaemon>> | undefined} */
    let daemon;
    t.teardown(async () => {
      try {
        await daemon?.shutdown();
      } finally {
        await rm(statePath, { recursive: true, force: true });
      }
    });
    const store = makeFsStore(powers, statePath);
    daemon = await makeThixotropeDaemon(powers, {
      store,
      engine: makeIronhorseEngine(powers, {
        workerBinary,
        bootPaths,
        storePath: join(statePath, 'heaps'),
      }),
      codec: syrupCodec,
      makeNetlayer: ({ handlers, logger }) =>
        makeTcpNetLayer({ handlers, logger }),
    });
    const worker = await daemon.createWorker({ debugLabel: 'frames' });
    const root = await worker.evaluate("Far('Echo', { len: s => s.length })");
    const client = await daemon.openTransientClient();
    t.teardown(() => client.close());
    const echo = await client.lookup(daemon.publish(root));
    t.is(await E(echo).len('ok'), 2);

    const journal = store.provideWorkerStore(worker.workerId);
    const entries = journal.journalLength();
    // Just over the ceiling, and far over the size that halts a vat.
    for (const size of [DEFAULT_VAT_FRAME_BYTES, 1_000_000]) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(() => E(echo).len('y'.repeat(size)), {
        message: FRAME_TOO_LARGE,
      });
    }
    t.is(journal.journalLength(), entries, 'nothing reached the journal');
    t.is(await E(echo).len('still'), 5, 'the vat still serves');
    t.true(journal.journalLength() > entries, 'the small call was journaled');
    t.is(journal.getMeta().failure, undefined, 'and has not halted');
  },
);
