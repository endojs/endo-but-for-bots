// @ts-check
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';

import { serveThixotrope } from '../src/control/supervisor.js';
import { connectLocalControl } from '../src/control/local-control.js';
import { makePeerJournalReplayEngine } from '../src/core/peer-replay-engine.js';
import { makeNodePowers } from '../src/platform/node/powers.js';

const powers = makeNodePowers();

/** @param {import('ava').ExecutionContext} t */
const start = async t => {
  const path = await mkdtemp('/tmp/thix-install-app-');
  t.teardown(() => rm(path, { recursive: true, force: true }));
  const supervisor = await serveThixotrope(powers, path, {
    engine: harden({
      ...makePeerJournalReplayEngine(powers),
      acquireStore: async () => async () => {},
    }),
  });
  t.teardown(() => supervisor.close());
  const client = await connectLocalControl(powers, join(path, 'control.sock'));
  t.teardown(() => client.close());
  return { supervisor, client };
};

/**
 * An `install` call is still allocating when the next call arrives; wait
 * until the registry lists the name before acting on it.
 * @param {any} client
 * @param {string} name
 */
const listed = async (client, name) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const entry = (await client.call('installations')).find(
      (/** @type {{name: string}} */ candidate) => candidate.name === name,
    );
    if (entry !== undefined) return entry;
    // eslint-disable-next-line no-await-in-loop
    await setTimeout(20);
  }
  throw Error(`${name} was never listed`);
};

/**
 * @param {Promise<unknown>} promise
 * @param {number} ms
 */
const settlesWithin = (promise, ms) =>
  Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    setTimeout(ms, false),
  ]);

test.serial(
  'a pending factory holds neither removal, collection nor other installations',
  async t => {
    t.timeout(60_000);
    const { client } = await start(t);
    await client.call(
      'evaluate',
      "globalThis.gate = new Promise(resolve => { globalThis.openGate = resolve; }); inventory.set('gate', Far('Gate', { wait: () => gate })); undefined",
    );
    const pending = client.call(
      'install',
      'slow',
      "({ make: async ({ gate }) => { await E(gate).wait(); return Far('Slow', { read: () => 1n }); } })",
      [['gate', 'gate']],
    );
    void pending.catch(() => {});
    t.like(await listed(client, 'slow'), {
      kind: 'application',
      status: 'pending',
    });
    // Another installation completes while the first factory waits.
    await client.call(
      'install',
      'quick',
      "({ make: () => Far('Quick', { read: () => 2n }) })",
      [],
    );
    t.is(
      await client.call('evaluate', "E(inventory.get('quick')).read()"),
      '2n',
    );
    t.deepEqual(await client.call('collect'), []);
    // Removing the pending installation retires its vat, which settles the
    // factory call as broken; the install reports that.
    t.true(await client.call('remove', 'slow'));
    await t.throwsAsync(() => pending, { message: /retired/ });
    t.is(
      (await client.call('installations')).find(entry => entry.name === 'slow'),
      undefined,
    );
    t.is(await client.call('evaluate', "inventory.has('slow')"), 'false');
  },
);

test.serial(
  'a bundle that does not evaluate leaves a removable failure',
  async t => {
    t.timeout(60_000);
    const { client } = await start(t);
    await t.throwsAsync(
      () => client.call('install', 'broken', '({ make: ', []),
      {
        message: /Unexpected token|Unexpected end of input|SyntaxError|missing/,
      },
    );
    const broken = (await client.call('installations')).find(
      entry => entry.name === 'broken',
    );
    t.is(broken.status, 'failed');
    t.regex(
      broken.error,
      /Unexpected token|Unexpected end of input|SyntaxError|missing/,
    );
    await t.throwsAsync(
      () =>
        client.call(
          'install',
          'broken',
          "({ make: () => Far('Fixed', { read: () => 3n }) })",
          [],
        ),
      { message: /different installation/ },
    );
    t.true(await client.call('remove', 'broken'));
    await client.call(
      'install',
      'broken',
      "({ make: () => Far('Fixed', { read: () => 3n }) })",
      [],
    );
    t.is(
      await client.call('evaluate', "E(inventory.get('broken')).read()"),
      '3n',
    );
  },
);

test.serial(
  'a root whose name was taken meanwhile fails its installation until it is removed',
  async t => {
    t.timeout(60_000);
    const { client } = await start(t);
    await client.call(
      'evaluate',
      "globalThis.waits = 0; globalThis.gate = new Promise(resolve => { globalThis.openGate = resolve; }); inventory.set('gate', Far('Gate', { wait: () => { waits += 1; return gate; } })); undefined",
    );
    const pending = client.call(
      'install',
      'taken',
      "({ make: async ({ gate }) => { await E(gate).wait(); return Far('Taken', { read: () => 4n }); } })",
      [['gate', 'gate']],
    );
    void pending.catch(() => {});
    t.like(await listed(client, 'taken'), { status: 'pending' });
    await client.call(
      'evaluate',
      "inventory.set('taken', 'user value'); undefined",
    );
    await client.call('evaluate', 'openGate(); undefined');
    await t.throwsAsync(() => pending, { message: /was taken/ });
    const failed = (await client.call('installations')).find(
      entry => entry.name === 'taken',
    );
    t.is(failed.status, 'failed');
    t.regex(failed.error, /was taken/);
    t.is(
      await client.call('evaluate', "inventory.get('taken')"),
      "'user value'",
    );
    // Freeing the name does not revive the installation; removing it does,
    // and installing again runs the factory in a fresh vat.
    await client.call('evaluate', "inventory.delete('taken'); undefined");
    t.true(await client.call('remove', 'taken'));
    const retried = client.call(
      'install',
      'taken',
      "({ make: async ({ gate }) => { await E(gate).wait(); return Far('Taken', { read: () => 4n }); } })",
      [['gate', 'gate']],
    );
    t.true(await settlesWithin(retried, 10_000));
    t.like(await retried, { status: 'ready', error: undefined });
    t.is(
      await client.call('evaluate', "E(inventory.get('taken')).read()"),
      '4n',
    );
    t.is(
      await client.call('evaluate', 'waits'),
      '2',
      'each installation ran its factory',
    );
  },
);
