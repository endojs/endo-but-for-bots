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
  'directory installs use separate manager vats and independent startup notices',
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
      await host.client.call('evaluate', 'typeof nativeModuleInitializations'),
      "'undefined'",
    );
    t.is(
      await host.client.call('evaluate', "E(inventory.get('one')).starts()"),
      '0',
    );
    t.is(
      await host.client.call('evaluate', "E(inventory.get('two')).starts()"),
      '0',
    );
    const status = await host.client.call('status');
    const managers = status.workers.filter(worker =>
      worker.debugLabel?.startsWith('native:'),
    );
    t.is(managers.length, 2);
    t.not(managers[0].workerId, managers[1].workerId);
    for (const manager of managers) {
      t.not(manager.workerId, status.workspace);
      t.truthy(manager.startNotify);
    }
    t.falsy(
      status.workers.find(worker => worker.workerId === status.workspace)
        .startNotify,
    );
    t.is(
      await host.client.call(
        'evaluate',
        "E(inventory.get('one')).initializations()",
      ),
      '1',
    );
    t.is(
      await host.client.call(
        'evaluate',
        "E(inventory.get('two')).initializations()",
      ),
      '1',
    );
    await host.client.call(
      'evaluate',
      "E(inventory.get('one')).setMarker('one only')",
    );
    t.is(
      await host.client.call('evaluate', "E(inventory.get('two')).getMarker()"),
      'undefined',
    );
    t.is(await host.client.call('evaluate', 'typeof marker'), "'undefined'");
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

test.serial('collection waits for native installation to finish', async t => {
  t.timeout(30_000);
  const path = await mkdtemp('/tmp/thix-install-collect-');
  t.teardown(() => rm(path, { recursive: true, force: true }));
  const started = makePromiseKit();
  const gate = makePromiseKit();
  const engine = makePeerJournalReplayEngine(powers);
  const supervisor = await serveThixotrope(powers, path, {
    engine: harden({
      ...engine,
      acquireStore: async () => async () => {},
      start: async options => {
        if (options.debugName.startsWith('native:')) {
          started.resolve(undefined);
          await gate.promise;
        }
        return engine.start(options);
      },
    }),
  });
  t.teardown(() => {
    gate.resolve(undefined);
    return supervisor.close();
  });
  const installer = await connectLocalControl(
    powers,
    join(path, 'control.sock'),
  );
  const collector = await connectLocalControl(
    powers,
    join(path, 'control.sock'),
  );
  t.teardown(() => installer.close());
  t.teardown(() => collector.close());
  const installing = installer.call(
    'installNative',
    'resource',
    fileURLToPath(new URL('./fixtures/native-package/', import.meta.url)),
  );
  await started.promise;
  const collecting = collector.call('collect');
  t.true(
    await Promise.race([collecting.then(() => false), setTimeout(50, true)]),
  );
  gate.resolve(undefined);
  await installing;
  const swept = await collecting;
  const status = await collector.call('status');
  const manager = status.workers.find(
    worker => worker.debugLabel === 'native:resource',
  );
  t.truthy(manager);
  t.false(swept.includes(manager.workerId));
  t.is(
    await collector.call(
      'evaluate',
      "E(inventory.get('resource')).initializations()",
    ),
    '1',
  );
});
