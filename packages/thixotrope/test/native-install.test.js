// @ts-check
import harden from '@endo/harden';
import { makePromiseKit } from '@endo/promise-kit';
import test from '@endo/ses-ava/test.js';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveThixotrope } from '../src/control/supervisor.js';
import { connectLocalControl } from '../src/control/local-control.js';
import { makePeerJournalReplayEngine } from '../src/core/peer-replay-engine.js';
import { describeNativeResource } from '../src/native/describe-resource.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { makeFsStore } from '../src/store/store-fs.js';

const powers = makeNodePowers();

/** @import { ExecutionContext } from 'ava' */

/**
 * A supervisor over the replay engine at `path`, with a control client, both
 * closed at teardown.
 * @param {ExecutionContext} t
 * @param {string} path
 */
const serve = async (t, path) => {
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
      new URL('./fixtures/native-resource/', import.meta.url),
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
    // The two installed here; the clock the supervisor provides is native too.
    const managers = status.workers.filter(
      worker =>
        worker.debugLabel?.startsWith('native:') &&
        worker.debugLabel !== 'native:clock',
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
        facet: Far('Registration', { ok: () => true }),
        lifecycle: Far('Lifecycle', { started: () => {}, exited: () => {} }),
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

test.serial(
  'shutdown does not wait for an installation being bundled',
  async t => {
    t.timeout(30_000);
    const path = await mkdtemp('/tmp/thix-install-close-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const { promise: started, resolve: bundleStarted } = makePromiseKit();
    const { promise: gate, resolve: releaseBundle } = makePromiseKit();
    const supervisor = await serveThixotrope(
      harden({
        ...powers,
        bundler: harden({
          ...powers.bundler,
          bundle: async file => {
            bundleStarted(undefined);
            await gate;
            return powers.bundler.bundle(file);
          },
        }),
      }),
      path,
      {
        engine: harden({
          ...makePeerJournalReplayEngine(powers),
          acquireStore: async () => async () => {},
        }),
      },
    );
    t.teardown(() => {
      releaseBundle(undefined);
      return supervisor.close();
    });
    const client = await connectLocalControl(
      powers,
      join(path, 'control.sock'),
    );
    t.teardown(() => client.close());
    const installing = client.call(
      'installNative',
      'resource',
      fileURLToPath(new URL('./fixtures/native-resource/', import.meta.url)),
    );
    const observed = installing.catch(error => {
      t.regex(error.message, /Session disconnected/);
    });
    await started;
    client.close();
    await client.closed;
    // Bundling is the host's and holds nothing durable: the stop proceeds, the
    // request fails with its connection, and the next start lists nothing
    // under the name; an installation the registry holds resumes, which the
    // Ironhorse lane covers.
    const closing = supervisor.close();
    t.false(
      await Promise.race([closing.then(() => false), setTimeout(2000, true)]),
      'shutdown did not wait for the bundling',
    );
    releaseBundle(undefined);
    await observed;
    const again = await serveThixotrope(powers, path, {
      engine: harden({
        ...makePeerJournalReplayEngine(powers),
        acquireStore: async () => async () => {},
      }),
    });
    t.teardown(() => again.close());
    const reconnected = await connectLocalControl(
      powers,
      join(path, 'control.sock'),
    );
    t.teardown(() => reconnected.close());
    t.is(
      (await reconnected.call('installations')).find(
        (/** @type {{name: string}} */ entry) => entry.name === 'resource',
      ),
      undefined,
    );
  },
);

test.serial(
  'native resource descriptions require both entry files',
  async t => {
    const path = await mkdtemp('/tmp/thix-native-resource-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    await writeFile(
      join(path, 'durable.js'),
      'export const make = () => ({});',
    );
    await t.throwsAsync(() => describeNativeResource(powers, path), {
      code: 'ENOENT',
    });
  },
);

test.serial(
  'native resource descriptions locate the entries and consult nothing else',
  async t => {
    const path = await mkdtemp('/tmp/thix-native-resource-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const source = 'export const make = () => ({});';
    await writeFile(join(path, 'durable.js'), source);
    // An entry must be the file that is there, not a link to one.
    await symlink(join(path, 'durable.js'), join(path, 'ephemeral.js'));
    await t.throwsAsync(() => describeNativeResource(powers, path), {
      message: /ephemeral\.js.*must be a file/,
    });
    await rm(join(path, 'ephemeral.js'));
    await writeFile(join(path, 'ephemeral.js'), source);
    // Links elsewhere and vendored packages are the bundler's concern, not
    // the description's: the identity is the pair of bundles, and nothing
    // about the directory beyond its entries is pinned.
    await symlink(join(path, 'durable.js'), join(path, 'alias.js'));
    await mkdir(join(path, 'node_modules'));
    const root = await realpath(path);
    t.deepEqual(await describeNativeResource(powers, path), {
      directory: root,
      durablePath: join(root, 'durable.js'),
      ephemeralPath: join(root, 'ephemeral.js'),
    });
  },
);

test.serial('collection spares a native installation in progress', async t => {
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
        // Only the installation under test; the clock the supervisor
        // provides is a native manager vat too.
        if (options.debugName.startsWith('native:resource')) {
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
    fileURLToPath(new URL('./fixtures/native-resource/', import.meta.url)),
  );
  await started.promise;
  // The manager vat is rooted by the registry's reference to its facade
  // once that has arrived, and kept by the host until then: a collection
  // made while its module is still being installed neither waits for the
  // installation nor sweeps the vat.
  const swept = await collector.call('collect');
  gate.resolve(undefined);
  await installing;
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

test.serial(
  'a start frees the bundles no launcher names and keeps the rest',
  async t => {
    t.timeout(60_000);
    const path = await mkdtemp('/tmp/thix-native-sweep-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    let host = await serve(t, path);
    const store = makeFsStore(powers, path);
    // What the supervisor provides: the clock's two bundles and the
    // mailbox's one, all still in the store at the start that installed
    // them; a bundle leaves the store only at a later start's sweep.
    const provided = store.listBundles();
    t.is(provided.length, 3);
    await host.client.call(
      'installNative',
      'one',
      fileURLToPath(new URL('./fixtures/native-resource/', import.meta.url)),
    );
    const installed = store
      .listBundles()
      .filter(digest => !provided.includes(digest));
    t.is(installed.length, 2, 'the installation put both of its bundles');
    for (const digest of installed) t.regex(digest, /^[0-9a-f]{64}$/);
    // A bundle nothing names: left by an installation interrupted before its
    // manager held the launcher, say.
    const orphan = store.putBundle(
      'module.exports = { make: () => undefined };\n',
    );
    t.deepEqual(
      store.listBundles(),
      [...provided, ...installed, orphan].sort(),
    );
    host.client.close();
    await host.supervisor.close();
    host = await serve(t, path);
    // The orphan and the bundles whose vats hold their code are freed; the
    // two a launcher names, the clock's and the installation's ephemeral
    // bundles, are kept.
    const kept = store.listBundles();
    t.is(kept.length, 2);
    t.is(kept.filter(digest => provided.includes(digest)).length, 1);
    t.is(kept.filter(digest => installed.includes(digest)).length, 1);
    t.true(await host.client.call('remove', 'one'));
    host.client.close();
    await host.supervisor.close();
    host = await serve(t, path);
    t.deepEqual(
      store.listBundles(),
      kept.filter(digest => provided.includes(digest)),
      'a removed installation frees its bundle at the next start',
    );
  },
);

test.serial(
  'editing or removing the directory after installation changes nothing for it',
  async t => {
    t.timeout(60_000);
    const path = await mkdtemp('/tmp/thix-native-edit-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    // The resource lives inside this package so that its ephemeral module
    // resolves `@endo/far` the way `resources/http` does; git ignores
    // `test/tmp`.
    const scratch = fileURLToPath(new URL('./tmp/', import.meta.url));
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(join(scratch, 'edited-'));
    t.teardown(() => rm(directory, { recursive: true, force: true }));
    /** @param {number} version */
    const writeEphemeral = version =>
      writeFile(
        join(directory, 'ephemeral.js'),
        `import { Far } from '@endo/far';\nexport const make = () => Far('Adapter', { version: () => ${version} });\n`,
      );
    await writeEphemeral(1);
    await writeFile(
      join(directory, 'durable.js'),
      `export const make = ({ adapters }) => harden({
        facet: Far('Versioned', {
          // A fresh process each time, so the answer is the stored bundle's.
          version: async () => {
            const incarnation = await E(adapters).create();
            const version = await E(E(incarnation).getRoot()).version();
            await E(incarnation).retire();
            return version;
          },
        }),
        lifecycle: Far('Lifecycle', { started: () => {}, exited: () => {} }),
      });`,
    );
    let host = await serve(t, path);
    await host.client.call('installNative', 'versioned', directory);
    const version = () =>
      host.client.call('evaluate', "E(inventory.get('versioned')).version()");
    t.is(await version(), '1');
    await writeEphemeral(2);
    t.is(
      await version(),
      '1',
      'a running installation launches from its stored bundle',
    );
    // The edited directory is a different installation; the name is taken.
    await t.throwsAsync(
      () => host.client.call('installNative', 'versioned', directory),
      { message: /different installation/ },
    );
    host.client.close();
    await host.supervisor.close();
    await rm(directory, { recursive: true, force: true });
    host = await serve(t, path);
    t.is(
      await version(),
      '1',
      'a restarted installation has no use for the directory',
    );
  },
);

test.serial(
  'a quarantined registry vat leaves the host serving from its index',
  async t => {
    t.timeout(60_000);
    const path = await mkdtemp('/tmp/thix-registry-quarantine-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const directory = fileURLToPath(
      new URL('./fixtures/native-resource/', import.meta.url),
    );
    let host = await serve(t, path);
    await host.client.call('installNative', 'one', directory);
    const { registry } = await host.client.call('status');
    host.client.close();
    await host.supervisor.close();
    // The registry vat halted: its metadata records the failure, as the
    // transport does for a delivery that ends a vat.
    const store = makeFsStore(powers, path);
    const workerStore = store.provideWorkerStore(registry);
    workerStore.setMeta({
      ...workerStore.getMeta(),
      failure: 'halted for the test',
    });
    host = await serve(t, path);
    const listed = await host.client.call('installations');
    t.deepEqual(
      listed.map((/** @type {{name: string}} */ entry) => entry.name).sort(),
      ['clock', 'mailbox', 'one'],
      'the index lists what the registry held',
    );
    const one = listed.find(
      (/** @type {{name: string}} */ entry) => entry.name === 'one',
    );
    t.like(one, { kind: 'native', status: 'ready' });
    t.false(
      Object.hasOwn(one, 'allocationKey'),
      "the index's own columns stay the host's",
    );
    await t.throwsAsync(
      () =>
        host.client.call('install', 'two', '({ make: () => undefined })', []),
      { message: /quarantined/ },
    );
    await t.throwsAsync(
      () => host.client.call('installNative', 'two', directory),
      { message: /quarantined/ },
    );
    const before = (await host.client.call('status')).workers.length;
    t.true(await host.client.call('remove', 'one'));
    t.is(
      (await host.client.call('status')).workers.length,
      before - 1,
      'the index named the vat to retire',
    );
    t.false(
      (await host.client.call('installations')).some(
        (/** @type {{name: string}} */ entry) => entry.name === 'one',
      ),
    );
    t.false(await host.client.call('remove', 'one'));
  },
);

test.serial(
  "the host's index covers a request before the registry has it, and is cleared of one it never got",
  async t => {
    t.timeout(60_000);
    const path = await mkdtemp('/tmp/thix-index-provisional-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const indexPath = join(path, 'installations.json');
    const entries = async () =>
      JSON.parse(await readFile(indexPath, 'utf8')).entries;
    let host = await serve(t, path);
    // A request the registry refuses leaves nothing in the index.
    await t.throwsAsync(
      () =>
        host.client.call('install', 'refused', '({ make: () => undefined })', [
          ['power', 'absent'],
        ]),
      { message: /Unknown inventory grant/ },
    );
    const listed = async (/** @type {string} */ name) =>
      (await entries()).find(
        (/** @type {{name: string}} */ entry) => entry.name === name,
      );
    t.is(await listed('refused'), undefined);
    host.client.close();
    await host.supervisor.close();
    // Two requests the registry never received, the host having ended
    // between recording them and handing them over: their bundles are kept
    // for them at the next start, the registry does not list them, one is
    // replaced by a new request under its name and the other removed.
    const store = makeFsStore(powers, path);
    const ghostBundle = store.putBundle('({ make: () => undefined })');
    const orphanBundle = store.putBundle('({ make: () => null })');
    const file = JSON.parse(await readFile(indexPath, 'utf8'));
    for (const [name, bundleDigest] of [
      ['ghost', ghostBundle],
      ['orphan', orphanBundle],
    ]) {
      file.entries.push({
        workspace: 'default',
        name,
        kind: 'application',
        digest: bundleDigest,
        grants: [],
        allocationKey: name === 'ghost' ? '3'.repeat(32) : '4'.repeat(32),
        bundleDigest,
        status: 'pending',
        provisional: true,
      });
    }
    await writeFile(indexPath, JSON.stringify(file));
    host = await serve(t, path);
    t.true(store.listBundles().includes(ghostBundle));
    t.true(store.listBundles().includes(orphanBundle));
    const names = (await host.client.call('installations')).map(
      (/** @type {{name: string}} */ entry) => entry.name,
    );
    t.false(names.includes('ghost'));
    t.false(names.includes('orphan'));
    t.like(
      await host.client.call(
        'install',
        'ghost',
        '({ make: () => "placed" })',
        [],
      ),
      { name: 'ghost', status: 'ready' },
    );
    t.is((await listed('ghost'))?.provisional, undefined);
    t.is((await listed('ghost'))?.status, 'ready');
    t.true(await host.client.call('remove', 'orphan'));
    t.is(await listed('orphan'), undefined);
    t.false(await host.client.call('remove', 'orphan'));
    host.client.close();
    await host.supervisor.close();
    host = await serve(t, path);
    t.false(
      store.listBundles().includes(ghostBundle),
      'the bundle of the replaced request is freed',
    );
    t.false(
      store.listBundles().includes(orphanBundle),
      'the bundle of the removed request is freed',
    );
    t.is(
      await host.client.call('evaluate', "inventory.get('ghost')"),
      "'placed'",
    );
  },
);
