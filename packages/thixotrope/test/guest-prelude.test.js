// @ts-check
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { connectLocalControl } from '../src/control/local-control.js';
import { serveThixotrope } from '../src/control/supervisor.js';
import { makePeerJournalReplayEngine } from '../src/core/peer-replay-engine.js';
import { guestPrelude } from '../src/guest/prelude.js';
import { makeNodePowers } from '../src/platform/node/powers.js';

const nodePowers = makeNodePowers();

test.serial('every vat has the guest prelude as globals', async t => {
  t.timeout(30_000);
  const root = await mkdtemp('/tmp/thix-prelude-');
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
  // The control protocol answers evaluate with a description of the value.
  const names = Object.keys(guestPrelude);
  t.is(
    await client.call(
      'evaluate',
      `${JSON.stringify(names)}.filter(name => typeof globalThis[name] !== 'function' && typeof globalThis[name] !== 'object')`,
    ),
    '[]',
    'each name is in scope in the workspace vat',
  );
  // An exo with an interface guard: the vocabulary host code is held to is
  // usable in a vat, and its guard is enforced there.
  t.is(
    await client.call(
      'evaluate',
      `(() => {
        const counter = makeExo('Counter', M.interface('Counter', { add: M.call(M.bigint()).returns(M.bigint()) }), {
          add(n) { return 1n + n; },
        });
        const enqueue = makeSerialQueue();
        return E(counter).add(2n).then(sum => enqueue(() => sum));
      })()`,
    ),
    '3n',
  );
  await t.throwsAsync(
    () =>
      client.call(
        'evaluate',
        `E(makeExo('Counter', M.interface('Counter', { add: M.call(M.bigint()).returns(M.bigint()) }), { add(n) { return n; } })).add('two')`,
      ),
    { message: /string "two" - Must be a bigint/ },
  );
});
