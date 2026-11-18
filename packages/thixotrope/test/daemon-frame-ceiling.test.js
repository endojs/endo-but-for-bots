// @ts-check
// The daemon bounds the frames its hub forwards into a vat
// (`vatFrameBytes`, from THIXOTROPE_VAT_FRAME_BYTES under a supervisor): an
// adapter-side caller's oversized message breaks to it before the vat's
// journal sees it.
import { E } from '@endo/far';
import { syrupCodec } from '@endo/ocapn/syrup';
import test from '@endo/ses-ava/test.js';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { serveThixotrope } from '../src/control/supervisor.js';
import {
  DEFAULT_VAT_FRAME_BYTES,
  makeThixotropeDaemon,
} from '../src/core/daemon.js';
import { makePeerJournalReplayEngine } from '../src/core/peer-replay-engine.js';
import { FRAME_TOO_LARGE } from '../src/net/hub.js';
import { makeMemoryStore } from '../src/store/store-memory.js';

import { makeNodePowers } from '../src/platform/node/powers.js';

const nodePowers = makeNodePowers();

/**
 * @param {import('ava').ExecutionContext} t
 * @param {{ vatFrameBytes?: number }} [options]
 */
const setup = async (t, options = {}) => {
  const store = makeMemoryStore();
  const daemon = await makeThixotropeDaemon(nodePowers, {
    store,
    engine: makePeerJournalReplayEngine(nodePowers),
    codec: syrupCodec,
    makeNetlayer: () => ({
      location: {
        type: 'ocapn-peer',
        network: 'test',
        transport: 'test',
        designator: 'frames',
        hints: false,
      },
      shutdown() {},
    }),
    ...options,
  });
  t.teardown(() => daemon.shutdown());
  const worker = await daemon.createWorker();
  const root = await worker.evaluate("Far('Echo', { len: s => s.length })");
  const client = await daemon.openTransientClient();
  t.teardown(() => client.close());
  const echo = await client.lookup(daemon.publish(root));
  const journal = store.provideWorkerStore(worker.workerId);
  return { echo, journal };
};

test.serial('a vat is not sent a frame over the default ceiling', async t => {
  t.timeout(20_000);
  const { echo, journal } = await setup(t);
  t.is(await E(echo).len('ok'), 2);
  const entries = journal.journalLength();
  await t.throwsAsync(() => E(echo).len('y'.repeat(DEFAULT_VAT_FRAME_BYTES)), {
    message: FRAME_TOO_LARGE,
  });
  t.is(journal.journalLength(), entries, 'nothing was journaled');
  t.is(await E(echo).len('still'), 5);
  t.is(journal.journalLength(), entries + 1);
});

test.serial('vatFrameBytes raises the ceiling', async t => {
  t.timeout(20_000);
  const { echo } = await setup(t, {
    vatFrameBytes: 2 * DEFAULT_VAT_FRAME_BYTES,
  });
  t.is(
    await E(echo).len('y'.repeat(DEFAULT_VAT_FRAME_BYTES)),
    DEFAULT_VAT_FRAME_BYTES,
  );
});

test.serial(
  'a malformed THIXOTROPE_VAT_FRAME_BYTES is refused before the state directory is touched',
  async t => {
    t.timeout(20_000);
    const base = await mkdtemp('/tmp/thix-vat-frame-');
    t.teardown(() => rm(base, { recursive: true, force: true }));
    const path = join(base, 'state');
    for (const text of [
      '0',
      '1023',
      '8388609',
      '-1',
      '3.5',
      'big',
      '',
      '01024',
    ]) {
      const powers = {
        ...nodePowers,
        environment: {
          ...nodePowers.environment,
          /** @param {string} name */
          get: name =>
            name === 'THIXOTROPE_VAT_FRAME_BYTES'
              ? text
              : nodePowers.environment.get(name),
        },
      };
      // eslint-disable-next-line no-await-in-loop
      const error = await serveThixotrope(powers, path).then(
        async supervisor => {
          await supervisor.close();
          return undefined;
        },
        reason => reason,
      );
      t.regex(
        String(error?.message),
        /THIXOTROPE_VAT_FRAME_BYTES must be a decimal integer between 1024 and 8388608/,
        `refuses ${JSON.stringify(text)}`,
      );
    }
    await t.throwsAsync(() => stat(path), { code: 'ENOENT' });
  },
);
