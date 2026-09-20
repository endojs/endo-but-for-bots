// @ts-check
import harden from '@endo/harden';
import { makePromiseKit } from '@endo/promise-kit';
import test from '@endo/ses-ava/test.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveThixotrope } from '../src/control/supervisor.js';
import { connectLocalControl } from '../src/control/local-control.js';
import { makePeerJournalReplayEngine } from '../src/core/peer-replay-engine.js';
import { makeNodePowers } from '../src/platform/node/powers.js';

const powers = makeNodePowers();

test.serial(
  'directory installs have stable inventory results and share startup dispatch',
  async t => {
    t.timeout(60_000);
    const path = await mkdtemp('/tmp/thix-native-install-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const start = async () => {
      const supervisor = await serveThixotrope(powers, path, {
        engine: harden({
          ...makePeerJournalReplayEngine(powers),
          acquireStore: async () => async () => {},
        }),
      });
      t.teardown(() => supervisor.close());
      const client = await connectLocalControl(
        powers,
        join(path, 'control.sock'),
      );
      t.teardown(() => client.close());
      return { supervisor, client };
    };
    let host = await start();
    const directory = fileURLToPath(
      new URL('./fixtures/native-package/', import.meta.url),
    );
    const first = await host.client.call('installNative', 'one', directory);
    t.deepEqual(
      await host.client.call('installNative', 'one', directory),
      first,
    );
    await host.client.call('installNative', 'two', directory);
    t.is(
      await host.client.call('evaluate', 'nativeModuleInitializations'),
      '2',
    );
    t.is(
      await host.client.call('evaluate', "E(inventory.get('one')).starts()"),
      '0',
    );
    t.is(
      await host.client.call('evaluate', "E(inventory.get('two')).starts()"),
      '0',
    );
    await host.client.call(
      'evaluate',
      "(globalThis.one = inventory.get('one'), inventory.set('one', 'replacement'), true)",
    );
    await host.client.call('installNative', 'one', directory);
    t.is(
      await host.client.call('evaluate', "inventory.get('one')"),
      "'replacement'",
    );
    host.client.close();
    await host.supervisor.close();
    host = await start();
    t.is(await host.client.call('evaluate', 'E(one).starts()'), '1');
    t.is(
      await host.client.call('evaluate', "E(inventory.get('two')).starts()"),
      '1',
    );
  },
);

test.serial('shutdown waits for an accepted native installation', async t => {
  t.timeout(30_000);
  const path = await mkdtemp('/tmp/thix-install-close-');
  t.teardown(() => rm(path, { recursive: true, force: true }));
  const { promise: started, resolve: bundleStarted } = makePromiseKit();
  const { promise: gate, resolve: releaseBundle } = makePromiseKit();
  let released = false;
  const supervisor = await serveThixotrope(
    harden({
      ...powers,
      bundler: harden({
        bundle: async file => {
          bundleStarted(undefined);
          await gate;
          t.false(released, 'installation retains store ownership');
          return powers.bundler.bundle(file);
        },
      }),
    }),
    path,
    {
      engine: harden({
        ...makePeerJournalReplayEngine(powers),
        acquireStore: async () => async () => {
          released = true;
        },
      }),
    },
  );
  t.teardown(() => {
    releaseBundle(undefined);
    return supervisor.close();
  });
  const client = await connectLocalControl(powers, join(path, 'control.sock'));
  t.teardown(() => client.close());
  const installing = client.call(
    'installNative',
    'resource',
    fileURLToPath(new URL('./fixtures/native-package/', import.meta.url)),
  );
  const observed = installing.catch(error => {
    t.regex(error.message, /Session disconnected/);
  });
  await started;
  client.close();
  await client.closed;
  const closing = supervisor.close();
  t.true(await Promise.race([closing.then(() => false), setTimeout(50, true)]));
  releaseBundle(undefined);
  await closing;
  await observed;
  t.true(released);
});

test.serial('native package descriptions require both entry files', async t => {
  const path = await mkdtemp('/tmp/thix-native-package-');
  t.teardown(() => rm(path, { recursive: true, force: true }));
  await writeFile(join(path, 'durable.js'), 'export const make = () => ({});');
  await t.throwsAsync(() => powers.nativePackages.describe(path), {
    code: 'ENOENT',
  });
});
