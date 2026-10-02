// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import { makePromiseKit } from '@endo/promise-kit';
import test from '@endo/ses-ava/test.js';

import { makeRegistry } from '../src/control/registry.js';
import { makeWorkspaceAccess } from '../src/control/workspace-access.js';

const RESTART = 'host restarted';

/**
 * The host, the index and a workspace as the registry sees them, in this
 * process: an installer whose vats are records with an evaluator, an index
 * that records what it is told, and the real workspace access over a Map.
 * The installer can be told to break the next answer as a host restart
 * would, and to count what it was asked.
 */
const fixture = () => {
  /** @type {string[]} */
  const log = [];
  /** @type {Map<string, any>} */
  const vats = new Map();
  /** @type {Map<string, string>} */
  const allocations = new Map();
  let nextWorker = 0;
  let breakNext = false;
  /** @type {((entry: any) => boolean) | undefined} */
  let refuseRecord;
  /** @type {import('@endo/promise-kit').PromiseKit<void> | undefined} */
  let holdFactory;
  /** @type {Map<string, (powers: any) => unknown>} */
  const factories = new Map();
  /** @type {Map<string, any>} */
  const index = new Map();
  const maybeBreak = () => {
    if (breakNext) {
      breakNext = false;
      throw Error(RESTART);
    }
  };
  /**
   * @param {string} workerId
   * @param {string} label
   */
  const makeVat = (workerId, label) => {
    let installed;
    let evaluations = 0;
    const evaluator = Far('Evaluator', {
      /**
       * @param {string} source
       * @param {{powers: any}} endowments
       */
      evaluate: async (source, { powers }) => {
        evaluations += 1;
        log.push(`factory ${label}`);
        if (holdFactory !== undefined) await holdFactory.promise;
        if (installed === undefined) {
          const make = factories.get(label);
          if (make === undefined) throw Error(`no factory for ${label}`);
          installed = make(powers);
        }
        return installed;
      },
    });
    return {
      workerId,
      staged: false,
      retired: false,
      evaluations: () => evaluations,
      facade: Far('Worker', {
        getId: () => workerId,
        getEvaluator: () => {
          maybeBreak();
          return evaluator;
        },
      }),
    };
  };
  const installer = Far('Installer', {
    /**
     * @param {string} label
     * @param {string} allocationKey
     */
    allocate: (label, allocationKey) => {
      log.push(`allocate ${label}`);
      let workerId = allocations.get(allocationKey);
      if (workerId === undefined) {
        nextWorker += 1;
        workerId = `w${nextWorker}`;
        allocations.set(allocationKey, workerId);
        vats.set(workerId, makeVat(workerId, label));
      }
      maybeBreak();
      return vats.get(workerId).facade;
    },
    /**
     * @param {string} workerId
     * @param {string} bundleDigest
     */
    stage: (workerId, bundleDigest) => {
      log.push(`stage ${workerId} ${bundleDigest}`);
      vats.get(workerId).staged = true;
      maybeBreak();
      return true;
    },
    /**
     * @param {string} workerId
     * @param {string} durableDigest
     * @param {string} ephemeralDigest
     */
    installNativeModule: (workerId, durableDigest, ephemeralDigest) => {
      log.push(`native ${workerId} ${durableDigest} ${ephemeralDigest}`);
      const vat = vats.get(workerId);
      if (durableDigest === 'broken') throw Error('factory failed');
      vat.facet ??= Far('Facet', { id: () => workerId });
      maybeBreak();
      return harden({ facet: vat.facet });
    },
    /** @param {string} workerId */
    retire: workerId => {
      log.push(`retire ${workerId}`);
      const vat = vats.get(workerId);
      if (vat === undefined) return false;
      vat.retired = true;
      vats.delete(workerId);
      return true;
    },
  });
  const indexFacet = Far('Index', {
    /**
     * @param {string} name
     * @param {any} entry
     */
    /**
     * @param {string | undefined} workspace
     * @param {string} name
     * @param {any} entry
     */
    record: (workspace, name, entry) => {
      if (refuseRecord?.(entry)) throw Error('index refused');
      index.set(workspace === undefined ? name : `${workspace}/${name}`, entry);
      maybeBreak();
    },
    /**
     * @param {string | undefined} workspace
     * @param {string} name
     */
    forget: (workspace, name) =>
      index.delete(workspace === undefined ? name : `${workspace}/${name}`),
  });
  const inventory = new Map();
  const workspace = makeWorkspaceAccess(inventory);
  const registry = makeRegistry({
    installer,
    index: indexFacet,
    restartMessage: RESTART,
  });
  return {
    registry,
    workspace,
    inventory,
    index,
    log,
    vats,
    factories,
    breakNextAnswer: () => {
      breakNext = true;
    },
    /** @param {import('@endo/promise-kit').PromiseKit<void>} kit */
    holdFactory: kit => {
      holdFactory = kit;
    },
    /** @param {((entry: any) => boolean) | undefined} refuse */
    refuseRecord: refuse => {
      refuseRecord = refuse;
    },
  };
};

/**
 * A workspace in front of the fixture's, whose `put` can be held and whose
 * `remove` can be made to refuse, as a quarantined workspace vat would.
 * @param {ReturnType<typeof fixture>} f
 * @param {{ refuseRemove?: boolean }} [options]
 */
const frontWorkspace = (f, { refuseRemove = false } = {}) => {
  /** @type {import('@endo/promise-kit').PromiseKit<void> | undefined} */
  let hold;
  let puts = 0;
  const workspace = Far('FrontWorkspace', {
    /** @param {any} grants */
    lookupGrants: grants => E(f.workspace).lookupGrants(grants),
    /** @param {string} name */
    has: name => E(f.workspace).has(name),
    /**
     * @param {string} name
     * @param {unknown} value
     */
    put: async (name, value) => {
      puts += 1;
      if (hold !== undefined) await hold.promise;
      return E(f.workspace).put(name, value);
    },
    /**
     * @param {string} name
     * @param {unknown} value
     */
    remove: (name, value) => {
      if (refuseRemove) throw Error('workspace quarantined');
      return E(f.workspace).remove(name, value);
    },
  });
  return harden({
    workspace,
    /** @param {import('@endo/promise-kit').PromiseKit<void> | undefined} kit */
    holdPut: kit => {
      hold = kit;
    },
    puts: () => puts,
  });
};

/**
 * @param {ReturnType<typeof fixture>} f
 * @param {Record<string, unknown>} [overrides]
 * @returns {any}
 */
const request = (f, overrides = {}) =>
  harden({
    name: 'app',
    kind: 'application',
    digest: 'code',
    allocationKey: 'key-1',
    grants: [['service', 'selected']],
    workspace: 'main',
    access: f.workspace,
    bundleDigest: 'bundle-1',
    ...overrides,
  });

test('an application is installed once: grants resolved, vat allocated, code staged, factory called, value placed', async t => {
  const f = fixture();
  const capability = Far('Granted', {});
  f.inventory.set('selected', capability);
  const root = Far('Application', {});
  f.factories.set('app:app', powers => {
    t.deepEqual(Object.keys(powers), ['alias', 'service']);
    t.is(powers.service, capability);
    return root;
  });
  const first = E(f.registry).install(
    request(f, {
      grants: [
        ['service', 'selected'],
        ['alias', 'selected'],
      ],
    }),
  );
  // A retry with the same identity, grants in another order, is the same
  // installation and shares its result.
  const second = E(f.registry).install(
    request(f, {
      allocationKey: 'unused',
      grants: [
        ['alias', 'selected'],
        ['service', 'selected'],
      ],
    }),
  );
  t.is(await (await first).result, root);
  t.is(await (await second).result, root);
  t.is(f.inventory.get('app'), root);
  t.deepEqual(f.log, [
    'allocate app:app',
    'stage w1 bundle-1',
    'factory app:app',
  ]);
  t.like((await E(f.registry).list())[0], {
    name: 'app',
    kind: 'application',
    status: 'ready',
    grants: [
      ['alias', 'selected'],
      ['service', 'selected'],
    ],
  });
  t.deepEqual(f.registry.lookup('app', 'main'), {
    kind: 'application',
    workerId: 'w1',
    value: root,
    status: 'ready',
  });
  t.like(f.index.get('main/app'), { workerId: 'w1', status: 'ready' });
  await t.throwsAsync(
    () => E(f.registry).install(request(f, { digest: 'different' })),
    { message: /different installation/ },
  );
});

test('grants are checked in the workspace before any vat exists', async t => {
  const f = fixture();
  f.inventory.set('data', harden({ not: 'a capability' }));
  await t.throwsAsync(
    () =>
      E(f.registry).install(request(f, { grants: [['service', 'absent']] })),
    { message: /Unknown inventory grant/ },
  );
  await t.throwsAsync(
    () => E(f.registry).install(request(f, { grants: [['service', 'data']] })),
    { message: /remotable capabilities/ },
  );
  await t.throwsAsync(
    () =>
      E(f.registry).install(
        request(f, {
          grants: [
            ['service', 'data'],
            ['service', 'data'],
          ],
        }),
      ),
    { message: /Duplicate power name/ },
  );
  f.inventory.set('app', Far('Occupant', {}));
  await t.throwsAsync(() => E(f.registry).install(request(f, { grants: [] })), {
    message: /already occupied/,
  });
  t.deepEqual(f.log, [], 'nothing was allocated');
  t.deepEqual(await E(f.registry).list(), []);
});

test('a failed factory stays inspectable and is not run again; removal frees the name', async t => {
  const f = fixture();
  let attempts = 0;
  f.factories.set('app:app', () => {
    attempts += 1;
    throw Error('factory failed');
  });
  const { result } = await E(f.registry).install(request(f, { grants: [] }));
  await t.throwsAsync(() => /** @type {Promise<unknown>} */ (result), {
    message: /factory failed/,
  });
  t.like((await E(f.registry).list())[0], {
    status: 'failed',
    error: 'factory failed',
  });
  const again = await E(f.registry).install(request(f, { grants: [] }));
  await t.throwsAsync(() => /** @type {Promise<unknown>} */ (again.result), {
    message: /factory failed/,
  });
  t.is(attempts, 1, 'the vat memoises the factory call');
  t.false(f.inventory.has('app'));
  t.like(f.index.get('main/app'), {
    status: 'failed',
    error: 'factory failed',
  });
  t.true(await E(f.registry).remove('app', 'main'));
  t.true(f.vats.size === 0, 'the vat was retired');
  t.false(f.index.has('main/app'));
  t.false(await E(f.registry).remove('app', 'main'));
  t.deepEqual(await E(f.registry).list(), []);
});

test('a native resource is installed through its manager and its facet placed; removal takes it back', async t => {
  const f = fixture();
  const { result } = await E(f.registry).install(
    request(f, {
      name: 'web',
      kind: 'native',
      digest: 'pair',
      grants: undefined,
      bundleDigest: undefined,
      durableDigest: 'durable-1',
      ephemeralDigest: 'ephemeral-1',
    }),
  );
  const facet = /** @type {any} */ (await result);
  t.is(await E(facet).id(), 'w1');
  t.is(f.inventory.get('web'), facet);
  t.deepEqual(f.log, [
    'allocate native:web',
    'native w1 durable-1 ephemeral-1',
  ]);
  t.like(f.index.get('main/web'), { kind: 'native', status: 'ready' });
  t.is(
    f.index.get('main/web')?.durableDigest,
    undefined,
    'the index stops naming a bundle once the manager holds it',
  );
  t.is(f.index.get('main/web')?.ephemeralDigest, undefined);
  // A value the user put under the name since is theirs.
  const theirs = Far('Theirs', {});
  f.inventory.set('web', theirs);
  t.true(await E(f.registry).remove('web', 'main'));
  t.is(f.inventory.get('web'), theirs);
  t.deepEqual(f.log.at(-1), 'retire w1');
  await t.throwsAsync(
    () =>
      E(f.registry).install(request(f, { kind: 'native', grants: undefined })),
    { message: /names its two bundles/ },
  );
});

test('a host answer broken by a restart is made again, under the same allocation', async t => {
  const f = fixture();
  const root = Far('Application', {});
  f.factories.set('app:app', () => root);
  f.breakNextAnswer();
  const { result } = await E(f.registry).install(request(f, { grants: [] }));
  t.is(await result, root);
  t.deepEqual(
    f.log,
    [
      'allocate app:app',
      'allocate app:app',
      'stage w1 bundle-1',
      'factory app:app',
    ],
    'the allocation was asked for again and found',
  );
  t.is(f.vats.size, 1, 'one vat');
});

test('a removal while the driver runs ends the installation at its next step', async t => {
  const f = fixture();
  const gate = makePromiseKit();
  f.holdFactory(gate);
  f.factories.set('app:app', () => Far('Application', {}));
  // The install answers once the factory has been called; the factory is
  // held, so the driver is inside the one guest-to-guest step a removal can
  // overtake.
  const { result: driving } = await E(f.registry).install(
    request(f, { grants: [] }),
  );
  const result = /** @type {Promise<unknown>} */ (driving);
  void result.catch(() => {});
  while (!f.log.includes('factory app:app')) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  t.true(await E(f.registry).remove('app', 'main'));
  t.deepEqual(
    f.log.filter(line => line.startsWith('retire')),
    ['retire w1'],
    'the vat was retired before the name was forgotten',
  );
  t.false(f.index.has('main/app'));
  gate.resolve(undefined);
  await t.throwsAsync(() => result, { message: /Installation was removed/ });
  t.false(
    f.inventory.has('app'),
    'the value was not placed under a removed name',
  );
  t.deepEqual(await E(f.registry).list(), []);
  t.false(
    f.index.has('main/app'),
    'the record of a removed name was not made again',
  );
});

test('a removal that lands while the value is being placed takes it back out', async t => {
  const f = fixture();
  const front = frontWorkspace(f);
  const gate = makePromiseKit();
  front.holdPut(gate);
  const root = Far('Application', {});
  f.factories.set('app:app', () => root);
  const { result: driving } = await E(f.registry).install(
    request(f, { grants: [], access: front.workspace }),
  );
  const result = /** @type {Promise<unknown>} */ (driving);
  void result.catch(() => {});
  while (front.puts() === 0) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  // The removal finds nothing in the workspace yet; the placement, landing
  // after it, finds the name gone and takes the value out itself.
  t.true(await E(f.registry).remove('app', 'main'));
  t.false(f.index.has('main/app'));
  gate.resolve(undefined);
  await t.throwsAsync(() => /** @type {Promise<unknown>} */ (result), {
    message: /Installation was removed/,
  });
  t.false(f.inventory.has('app'), 'the value was taken back out');
  t.deepEqual(await E(f.registry).list(), []);
  t.false(
    f.index.has('main/app'),
    'the placement did not record the removed name',
  );
});

test('a name taken while an installation runs fails it, and the installation keeps the name from no one', async t => {
  const f = fixture();
  const front = frontWorkspace(f);
  const root = Far('Application', {});
  f.factories.set('app:app', () => root);
  // The name is taken while the factory runs, so the value cannot be placed.
  const factoryGate = makePromiseKit();
  f.holdFactory(factoryGate);
  const { result: first } = await E(f.registry).install(
    request(f, { grants: [], access: front.workspace }),
  );
  const occupant = Far('Occupant', {});
  f.inventory.set('app', occupant);
  factoryGate.resolve(undefined);
  await t.throwsAsync(() => /** @type {Promise<unknown>} */ (first), {
    message: /was taken by another value/,
  });
  t.like((await E(f.registry).list())[0], { status: 'failed' });
  t.is(f.index.get('main/app')?.status, 'failed');
  // Freeing the name does not revive it: the same identity installed again
  // finds the failed installation, and only a removal clears it.
  f.inventory.delete('app');
  const { result: again } = await E(f.registry).install(
    request(f, { grants: [], access: front.workspace }),
  );
  await t.throwsAsync(() => /** @type {Promise<unknown>} */ (again), {
    message: /was taken by another value/,
  });
  t.false(f.inventory.has('app'), 'nothing was placed');
  // Removing the failed installation retires its vat and leaves a value the
  // user put under the name since.
  f.inventory.set('app', occupant);
  t.true(await E(f.registry).remove('app', 'main'));
  t.true(f.log.includes('retire w1'));
  t.is(f.inventory.get('app'), occupant);
  f.inventory.delete('app');
  // A new request, under a new allocation key, as the host makes for each.
  const { result: fresh } = await E(f.registry).install(
    request(f, {
      grants: [],
      access: front.workspace,
      allocationKey: 'key-2',
    }),
  );
  t.is(await fresh, root);
  t.is(f.inventory.get('app'), root);
  t.like((await E(f.registry).list())[0], { status: 'ready' });
});

test('removing an installation placed before its index refused the record takes the value out', async t => {
  const f = fixture();
  const root = Far('Application', {});
  f.factories.set('app:app', () => root);
  f.refuseRecord(entry => entry.status === 'ready');
  const { result } = await E(f.registry).install(request(f, { grants: [] }));
  await t.throwsAsync(() => /** @type {Promise<unknown>} */ (result), {
    message: /index refused/,
  });
  t.like((await E(f.registry).list())[0], { status: 'failed' });
  t.is(f.inventory.get('app'), root, 'the value was placed');
  f.refuseRecord(undefined);
  t.true(await E(f.registry).remove('app', 'main'));
  t.false(f.inventory.has('app'), 'the removal took the value out');
});

test('a workspace that refuses to give a value back does not keep the name in the index', async t => {
  const f = fixture();
  const front = frontWorkspace(f, { refuseRemove: true });
  f.factories.set('app:app', () => Far('Application', {}));
  const { result } = await E(f.registry).install(
    request(f, { grants: [], access: front.workspace }),
  );
  await result;
  await t.throwsAsync(() => E(f.registry).remove('app', 'main'), {
    message: /workspace quarantined/,
  });
  t.deepEqual(
    f.log.filter(line => line.startsWith('retire')),
    ['retire w1'],
  );
  t.false(f.index.has('main/app'), 'the index forgot the name all the same');
  t.deepEqual(await E(f.registry).list(), []);
});

test('the same name in two workspaces is two installations, removed apart', async t => {
  const f = fixture();
  const other = new Map();
  const otherAccess = makeWorkspaceAccess(other);
  f.factories.set('app:app', () => Far('Application', {}));
  const { result: first } = await E(f.registry).install(
    request(f, { grants: [] }),
  );
  const { result: second } = await E(f.registry).install(
    request(f, {
      grants: [],
      workspace: 'other',
      access: otherAccess,
      allocationKey: 'key-2',
    }),
  );
  await first;
  await second;
  t.is(f.vats.size, 2, 'a vat each');
  t.deepEqual(
    (await E(f.registry).list())
      .map(entry => [entry.workspace, entry.name])
      .sort(),
    [
      ['main', 'app'],
      ['other', 'app'],
    ],
  );
  t.true(f.inventory.has('app'));
  t.true(other.has('app'));
  t.true(await E(f.registry).remove('app', 'other'));
  t.false(other.has('app'));
  t.true(f.inventory.has('app'), 'the other workspace keeps its own');
  t.is(f.vats.size, 1);
  t.true(f.index.has('main/app'));
  t.false(f.index.has('other/app'));
  t.is(await E(f.registry).lookup('app'), undefined, 'neither is daemon-wide');
});
