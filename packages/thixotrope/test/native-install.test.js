// @ts-check
import harden from '@endo/harden';
import { makePromiseKit } from '@endo/promise-kit';
import test from '@endo/ses-ava/test.js';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveThixotrope } from '../src/control/supervisor.js';
import { connectLocalControl } from '../src/control/local-control.js';
import { makePeerJournalReplayEngine } from '../src/core/peer-replay-engine.js';
import { describeNativePackage } from '../src/native/describe-package.js';
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
      t.true(manager.startNotice);
      t.false('startNotify' in manager);
      t.false('allocationKey' in manager);
    }
    t.false(
      status.workers.find(worker => worker.workerId === status.workspace)
        .startNotice,
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

test.serial(
  'a failed native installation keeps its name until it is removed',
  async t => {
    t.timeout(60_000);
    const path = await mkdtemp('/tmp/thix-native-remove-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
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
    const directory = join(path, 'package');
    await mkdir(directory);
    await writeFile(
      join(directory, 'package.json'),
      '{"name":"native-remove-fixture","type":"module"}',
    );
    await writeFile(
      join(directory, 'ephemeral.js'),
      'export const make = () => harden({});',
    );
    await writeFile(
      join(directory, 'durable.js'),
      "export const make = () => { throw Error('factory failed'); };",
    );
    await t.throwsAsync(() => client.call('installNative', 'web', directory), {
      message: /factory failed/,
    });
    const managersOf = async () =>
      (await client.call('status')).workers.filter(
        worker => worker.debugLabel === 'native:web',
      );
    t.is((await managersOf()).length, 1, 'the failure is kept in its manager');
    // A corrected package is a different installation: the name is taken.
    await writeFile(
      join(directory, 'durable.js'),
      `export const make = () => harden({
        registration: Far('Registration', { ok: () => true }),
        lifecycle: Far('Lifecycle', { started: () => {} }),
      });`,
    );
    await t.throwsAsync(() => client.call('installNative', 'web', directory), {
      message: /different installation/,
    });
    t.true(await client.call('remove', 'web'));
    t.is((await managersOf()).length, 0, 'removal retires the manager');
    t.false(await client.call('remove', 'web'));
    await client.call('installNative', 'web', directory);
    t.is(await client.call('evaluate', "E(inventory.get('web')).ok()"), 'true');
    t.true(await client.call('remove', 'web'));
    t.is(await client.call('evaluate', "inventory.has('web')"), 'false');
    t.is((await managersOf()).length, 0);
    await t.throwsAsync(() => client.call('remove', ''), {
      message: /inventory name/,
    });
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
  await t.throwsAsync(() => describeNativePackage(powers, path), {
    code: 'ENOENT',
  });
});

test.serial(
  'native package descriptions refuse links and node_modules',
  async t => {
    const path = await mkdtemp('/tmp/thix-native-package-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const source = 'export const make = () => ({});';
    await writeFile(join(path, 'durable.js'), source);
    await writeFile(join(path, 'ephemeral.js'), source);
    const { digest } = await describeNativePackage(powers, path);
    t.regex(digest, /^[0-9a-f]{64}$/);
    await symlink(join(path, 'durable.js'), join(path, 'alias.js'));
    await t.throwsAsync(() => describeNativePackage(powers, path), {
      message: /files or directories/,
    });
    await rm(join(path, 'alias.js'));
    t.is((await describeNativePackage(powers, path)).digest, digest);
    await mkdir(join(path, 'node_modules'));
    await t.throwsAsync(() => describeNativePackage(powers, path), {
      message: /node_modules/,
    });
  },
);

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
