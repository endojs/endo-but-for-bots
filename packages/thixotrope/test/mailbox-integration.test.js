// @ts-check
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { connectLocalControl } from '../src/local-control.js';
import { makePeerJournalReplayEngine } from '../src/peer-replay-engine.js';
import { makeNodePowers } from '../src/platform/node-powers.js';
import { serveThixotrope } from '../src/supervisor.js';
import { registerMailboxIntegration } from './_mailbox-integration.js';

const nodePowers = makeNodePowers();
registerMailboxIntegration(test, 'replay');

test.serial(
  'mail initialization can be repaired without restarting the supervisor',
  async t => {
    t.timeout(30_000);
    const root = await mkdtemp('/tmp/thix-mail-repair-');
    t.teardown(() => rm(root, { recursive: true, force: true }));
    const supervisor = await serveThixotrope(nodePowers, root, {
      engine: harden({
        ...makePeerJournalReplayEngine(nodePowers),
        acquireStore: async () => async () => {},
      }),
    });
    t.teardown(() => supervisor.close());
    const client = await connectLocalControl(
      nodePowers,
      join(root, 'control.sock'),
    );
    t.teardown(() => client.close());
    await client.call(
      'evaluate',
      "(() => { const broken = Promise.reject(Error('broken mailbox')); broken.catch(() => {}); globalThis.mailAddressBook = broken; return true; })()",
    );
    await t.throwsAsync(() => client.call('contacts'), {
      message: /broken mailbox/,
    });
    await client.call('evaluate', 'delete globalThis.mailAddressBook');
    t.deepEqual(await client.call('contacts'), []);
  },
);
