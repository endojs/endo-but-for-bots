// @ts-check
// Runtime container filesystem attach (designs/runtime-container-fs-mount.md):
// innerPath validation, cap possession, ref counting across sessions of a
// shared client, immediate push to the ClaudeClient, last-detach bridge
// teardown, and persistence replay across a simulated daemon restart.
import test from '@endo/ses-ava/prepare-endo.js';

import {
  attachKeyFor,
  makeContainerMountRegistrar,
  normalizeInnerPath,
} from '../src/container-mounts.js';

/**
 * Build a persisted record with the key the registrar will derive. A record
 * whose `key` is anything else is rejected on load — the key names the 9P
 * mountpoint and the host mount pet name, so two records sharing one would
 * collapse onto a single bridge.
 *
 * @param {{ clientKey: string, capId: string, innerPath: string, mode?: string, petName?: string, sessionIds?: string[] }} fields
 */
const persistedRecord = ({
  clientKey,
  capId,
  innerPath,
  mode = 'rw',
  petName = 'p',
  sessionIds = ['s1'],
}) =>
  harden({
    key: attachKeyFor(clientKey, capId, innerPath),
    clientKey,
    capId,
    innerPath,
    mode,
    petName,
    sessionIds,
  });

test('normalizeInnerPath admits /mnt/ paths and rejects escapes', t => {
  t.is(normalizeInnerPath('/mnt/project'), '/mnt/project');
  t.is(normalizeInnerPath('/mnt/a/b/'), '/mnt/a/b');
  t.is(normalizeInnerPath('/mnt//x'), '/mnt/x');
  t.throws(() => normalizeInnerPath('/workspace'), {
    message: /must lie under \/mnt\//,
  });
  t.throws(() => normalizeInnerPath('/mnt'), {
    message: /must lie under \/mnt\//,
  });
  t.throws(() => normalizeInnerPath('/mnt/'), {
    message: /must lie under \/mnt\//,
  });
  t.throws(() => normalizeInnerPath('mnt/x'), { message: /absolute/ });
  t.throws(() => normalizeInnerPath('/mnt/../etc'), {
    message: /must not contain/,
  });
  t.throws(() => normalizeInnerPath('/mnt/x/./y'), {
    message: /must not contain/,
  });
  t.throws(() => normalizeInnerPath(''), { message: /non-empty/ });
  t.throws(() => normalizeInnerPath('/mnt/has space'), {
    message: /segments must match/,
  });
  t.throws(() => normalizeInnerPath('/mnt/x:y'), {
    message: /segments must match/,
  });
});

/**
 * Harness: a Map-backed factory petstore (persistence), a fake bridge
 * provider that records provide/release calls, fake ClaudeClients that
 * record every setExtraMounts, and guests whose petstores are simple maps
 * from pet-name path to cap formula id.
 */
const makeHarness = () => {
  /** @type {Map<string, unknown>} */
  const names = new Map();
  // Tests may make one journal write fail, to pin that a failed write neither
  // destroys the previous snapshot nor is reported as success.
  /** @type {number} */
  let failStoresAfter = Infinity;
  let storeCount = 0;
  const powers = harden({
    async list() {
      return harden([...names.keys()]);
    },
    /** @param {string} name */
    async has(name) {
      return names.has(name);
    },
    /** @param {string} name */
    async lookup(name) {
      if (!names.has(name)) throw Error(`missing ${name}`);
      return names.get(name);
    },
    /** @param {string} name */
    async remove(name) {
      names.delete(name);
    },
    /**
     * @param {unknown} value
     * @param {string} name
     */
    async storeValue(value, name) {
      storeCount += 1;
      if (storeCount > failStoresAfter) {
        throw Error('petstore write failed');
      }
      if (names.has(name)) throw Error(`cannot overwrite ${name}`);
      names.set(name, value);
    },
  });
  /** @param {bigint} sequence */
  const journalName = sequence =>
    `floot-container-mounts-v1-${`${sequence}`.padStart(20, '0')}`;
  /** The records in the newest journal snapshot, or undefined if there is none. */
  const storedRecords = () => {
    const journal = [...names.keys()]
      .filter(name => name.startsWith('floot-container-mounts-v1-'))
      .sort();
    if (journal.length === 0) return undefined;
    return /** @type {any} */ (
      names.get(/** @type {string} */ (journal.at(-1)))
    ).records;
  };
  /** @type {{ key: string, capId: string, mode: string }[]} */
  const bridgeCalls = [];
  /** @type {string[]} */
  const releaseCalls = [];
  /** @type {string[]} */
  const handleUnmounts = [];
  // Tests may inject bridge failures per capId (replay resilience) and
  // observe the moment a release happens (push-before-release ordering).
  /** @type {Set<string>} */
  const failCapIds = new Set();
  /** @type {(() => void) | undefined} */
  let releaseObserver;
  const provider = harden({
    /** @param {{ key: string, capId: string, mode: string }} options */
    async provideContainerMountBridge({ key, capId, mode }) {
      if (failCapIds.has(capId)) {
        throw Error(`no bridge for ${capId}`);
      }
      bridgeCalls.push({ key, capId, mode });
      return harden({
        mountCap: harden({ kind: 'bridged-mount', key }),
        handle: harden({
          async unmount() {
            handleUnmounts.push(key);
          },
        }),
        mountPoint: `/host/mounts/claude-attach-${key}`,
      });
    },
    /** @param {string} key */
    async releaseContainerMountBridge(key) {
      if (releaseObserver) releaseObserver();
      releaseCalls.push(key);
    },
  });
  const makeClient = () => {
    /** @type {any[][]} */
    const sets = [];
    const client = harden({
      /** @param {any[]} extras */
      async setExtraMounts(extras) {
        sets.push([...extras]);
      },
    });
    return { sets, client };
  };
  /** @param {Map<string, string>} caps */
  const makeGuest = caps =>
    harden({
      /** @param {string[]} path */
      async identify(...path) {
        return caps.get(path.join('/'));
      },
    });
  const makeRegistrar = () =>
    makeContainerMountRegistrar({
      powers,
      getBridgeProvider: async () => provider,
    });
  return {
    names,
    powers,
    journalName,
    storedRecords,
    bridgeCalls,
    releaseCalls,
    handleUnmounts,
    failCapIds,
    failStoresAfter: (/** @type {number} */ n) => {
      failStoresAfter = n;
    },
    setReleaseObserver: (/** @type {() => void} */ fn) => {
      releaseObserver = fn;
    },
    makeClient,
    makeGuest,
    makeRegistrar,
  };
};

test('attach proves possession, bridges, persists, and pushes the bind', async t => {
  const h = makeHarness();
  const registrar = h.makeRegistrar();
  const { sets, client } = h.makeClient();
  const guest = h.makeGuest(new Map([['workspace', 'cap-1']]));
  const kit = registrar.makeSessionKit({
    sessionId: 's1',
    sessionGuest: guest,
  });
  await kit.arm({ clientKey: 'client-k1', client });
  // Nothing persisted → arming pushes nothing.
  t.deepEqual(sets, []);

  const info = await kit.attach({
    petName: 'workspace',
    innerPath: '/mnt/project',
  });
  t.like(info, {
    innerPath: '/mnt/project',
    mode: 'rw',
    petName: 'workspace',
    sessions: 1,
    heldByThisSession: true,
  });
  // Formula ids are bearer-capable, so the session-facing description must
  // NOT carry the capId (the persisted record below still does).
  t.false('capId' in info);
  t.is(h.bridgeCalls.length, 1);
  t.like(h.bridgeCalls[0], { capId: 'cap-1', mode: 'rw' });
  t.is(sets.length, 1);
  t.is(sets[0].length, 1);
  t.like(sets[0][0], { innerPath: '/mnt/project', mode: 'rw' });
  // The pushed bind must carry the BRIDGE's mount cap and handle, not some
  // other object — and, for a client that binds by declaration, the record
  // key and the host mountpoint the bridge chose.
  t.is(sets[0][0].cap.kind, 'bridged-mount');
  t.is(sets[0][0].cap.key, h.bridgeCalls[0].key);
  t.truthy(sets[0][0].handle);
  t.is(sets[0][0].key, h.bridgeCalls[0].key);
  t.is(
    sets[0][0].mountPoint,
    `/host/mounts/claude-attach-${h.bridgeCalls[0].key}`,
  );

  // Persisted for replay.
  const stored = /** @type {any[]} */ (h.storedRecords());
  t.is(stored.length, 1);
  t.like(stored[0], { capId: 'cap-1', innerPath: '/mnt/project', mode: 'rw' });
  t.deepEqual([...stored[0].sessionIds], ['s1']);

  // Idempotent re-attach: same (capId, innerPath) → no new bridge, no
  // recreate.
  await kit.attach({ petName: 'workspace', innerPath: '/mnt/project' });
  t.is(h.bridgeCalls.length, 1);
  t.is(sets.length, 1);
});

test('attach validates slots, modes, and possession', async t => {
  const h = makeHarness();
  const registrar = h.makeRegistrar();
  const { client } = h.makeClient();
  const guest = h.makeGuest(
    new Map([
      ['workspace', 'cap-1'],
      ['other', 'cap-2'],
    ]),
  );
  const kit = registrar.makeSessionKit({
    sessionId: 's1',
    sessionGuest: guest,
  });
  await kit.arm({ clientKey: 'ck', client });

  await t.throwsAsync(
    () => kit.attach({ petName: 'missing', innerPath: '/mnt/x' }),
    { message: /does not hold "missing"/ },
  );
  await t.throwsAsync(
    () => kit.attach({ petName: 'workspace', innerPath: '/workspace' }),
    { message: /must lie under \/mnt\// },
  );
  await t.throwsAsync(
    () => kit.attach({ petName: 'workspace', innerPath: '/mnt/x', mode: 'rx' }),
    { message: /mode must be/ },
  );

  await kit.attach({ petName: 'workspace', innerPath: '/mnt/a' });
  await t.throwsAsync(
    () => kit.attach({ petName: 'other', innerPath: '/mnt/a' }),
    { message: /different capability/ },
  );
  await t.throwsAsync(
    () => kit.attach({ petName: 'workspace', innerPath: '/mnt/a', mode: 'ro' }),
    { message: /already bound with mode "rw"/ },
  );
  await t.throwsAsync(
    () => kit.attach({ petName: 'other', innerPath: '/mnt/a/nested' }),
    { message: /overlaps/ },
  );
  await t.throwsAsync(
    () => kit.attach({ petName: 'other', innerPath: '/mnt' }),
    {
      message: /must lie under \/mnt\//,
    },
  );
});

test('an unarmed kit fails clearly and a failed bridge leaves no record', async t => {
  const h = makeHarness();
  const registrar = h.makeRegistrar();
  const guest = h.makeGuest(new Map([['workspace', 'cap-1']]));
  const kit = registrar.makeSessionKit({
    sessionId: 's1',
    sessionGuest: guest,
  });
  await t.throwsAsync(
    () => kit.attach({ petName: 'workspace', innerPath: '/mnt/x' }),
    { message: /not available for this session/ },
  );

  // A registrar whose provider refuses: the attach fails and persists
  // nothing.
  const failing = makeContainerMountRegistrar({
    powers: h.powers,
    getBridgeProvider: async () => undefined,
  });
  const { client } = h.makeClient();
  const kit2 = failing.makeSessionKit({ sessionId: 's1', sessionGuest: guest });
  await kit2.arm({ clientKey: 'ck', client });
  await t.throwsAsync(
    () => kit2.attach({ petName: 'workspace', innerPath: '/mnt/x' }),
    { message: /container-mount bridge provider/ },
  );
  t.is(h.storedRecords(), undefined);
});

test('two sessions of one client ref-count; the last detach releases', async t => {
  const h = makeHarness();
  const registrar = h.makeRegistrar();
  const { sets, client } = h.makeClient();
  // Both guests hold the SAME cap (identity is the formula id), under
  // different pet names.
  const guestA = h.makeGuest(new Map([['ws', 'cap-shared']]));
  const guestB = h.makeGuest(new Map([['adopted-ws', 'cap-shared']]));
  const kitA = registrar.makeSessionKit({
    sessionId: 'a',
    sessionGuest: guestA,
  });
  const kitB = registrar.makeSessionKit({
    sessionId: 'b',
    sessionGuest: guestB,
  });
  await kitA.arm({ clientKey: 'ck', client });
  await kitB.arm({ clientKey: 'ck', client });

  await kitA.attach({ petName: 'ws', innerPath: '/mnt/shared' });
  t.is(sets.length, 1);
  const infoB = await kitB.attach({
    petName: 'adopted-ws',
    innerPath: '/mnt/shared',
  });
  t.is(infoB.sessions, 2);
  // Same (capId, innerPath): the bridge is reused and the container view is
  // unchanged — no recreate.
  t.is(h.bridgeCalls.length, 1);
  t.is(sets.length, 1);

  const first = await kitA.detach({ innerPath: '/mnt/shared' });
  t.false(first.released);
  t.is(first.sessions, 1);
  t.is(sets.length, 1);
  t.deepEqual(h.releaseCalls, []);

  // Detaching a bind the session does not hold is refused.
  await t.throwsAsync(() => kitA.detach({ innerPath: '/mnt/shared' }), {
    message: /does not hold the bind/,
  });

  let setsAtRelease = -1;
  h.setReleaseObserver(() => {
    setsAtRelease = sets.length;
  });
  const last = await kitB.detach({ innerPath: '/mnt/shared' });
  t.true(last.released);
  // The slice is recreated WITHOUT the bind BEFORE the bridge is released —
  // unmounting 9P under a live container bind would be busy.
  t.is(sets.length, 2);
  t.is(setsAtRelease, 2);
  t.deepEqual(sets[1], []);
  t.is(h.releaseCalls.length, 1);
  t.is(h.releaseCalls[0], h.bridgeCalls[0].key);
  const stored = /** @type {any[]} */ (h.storedRecords());
  t.deepEqual([...stored], []);
});

test('a fresh registrar (daemon restart) replays persisted attaches on arm', async t => {
  const h = makeHarness();
  const registrarBefore = h.makeRegistrar();
  const before = h.makeClient();
  const guest = h.makeGuest(new Map([['data', 'cap-9']]));
  const kitBefore = registrarBefore.makeSessionKit({
    sessionId: 's',
    sessionGuest: guest,
  });
  await kitBefore.arm({ clientKey: 'ck9', client: before.client });
  await kitBefore.attach({
    petName: 'data',
    innerPath: '/mnt/data',
    mode: 'ro',
  });
  t.is(h.bridgeCalls.length, 1);

  // "Restart": a new registrar over the same petstore, a fresh client
  // incarnation. Arming replays the persisted attach — bridge re-provided
  // (same deterministic key), bind pushed before any turn runs.
  const registrarAfter = h.makeRegistrar();
  const after = h.makeClient();
  const kitAfter = registrarAfter.makeSessionKit({
    sessionId: 's',
    sessionGuest: guest,
  });
  await kitAfter.arm({ clientKey: 'ck9', client: after.client });
  t.is(h.bridgeCalls.length, 2);
  t.is(h.bridgeCalls[1].key, h.bridgeCalls[0].key);
  t.is(after.sets.length, 1);
  t.like(after.sets[0][0], { innerPath: '/mnt/data', mode: 'ro' });

  const listed = await kitAfter.list();
  t.is(listed.length, 1);
  t.like(listed[0], {
    innerPath: '/mnt/data',
    mode: 'ro',
    petName: 'data',
    heldByThisSession: true,
  });
});

test('releaseSession drops references and tears down orphaned bridges', async t => {
  const h = makeHarness();
  const registrar = h.makeRegistrar();
  const { sets, client } = h.makeClient();
  const guest = h.makeGuest(new Map([['data', 'cap-5']]));
  const kit = registrar.makeSessionKit({
    sessionId: 's5',
    sessionGuest: guest,
  });
  await kit.arm({ clientKey: 'ck5', client });
  await kit.attach({ petName: 'data', innerPath: '/mnt/data' });
  t.is(sets.length, 1);

  await registrar.releaseSession('s5');
  const stored = /** @type {any[]} */ (h.storedRecords());
  t.deepEqual([...stored], []);
  t.is(h.releaseCalls.length, 1);
  // The deleted session's own client is forgotten first, so no recreate is
  // wasted on a client that is being terminated.
  t.is(sets.length, 1);

  // Releasing a session with no attaches is a no-op.
  await registrar.releaseSession('never-seen');
  t.is(h.releaseCalls.length, 1);
});

test('the session tools drive attach, list, and detach end to end', async t => {
  const h = makeHarness();
  const registrar = h.makeRegistrar();
  const { client } = h.makeClient();
  const guest = h.makeGuest(new Map([['workspace', 'cap-1']]));
  const kit = registrar.makeSessionKit({
    sessionId: 's1',
    sessionGuest: guest,
  });

  // Tools exist (and are discoverable) before the client resolves, but say
  // so when called too early.
  const names = [...kit.tools.keys()];
  t.deepEqual(names.sort(), [
    'attachContainerMount',
    'detachContainerMount',
    'listContainerMounts',
  ]);
  for (const name of names) {
    t.is(kit.tools.get(name).schema().function.name, name);
  }
  await t.throwsAsync(
    () =>
      kit.tools.get('attachContainerMount').execute({
        petName: 'workspace',
        innerPath: '/mnt/p',
      }),
    { message: /not available for this session/ },
  );

  await kit.arm({ clientKey: 'ck', client });
  const attached = await kit.tools.get('attachContainerMount').execute({
    petName: 'workspace',
    innerPath: '/mnt/p',
  });
  t.regex(attached, /Attached "workspace" at \/mnt\/p \(rw\)/);
  const listed = await kit.tools.get('listContainerMounts').execute();
  t.regex(listed, /\/mnt\/p/);
  const detached = await kit.tools.get('detachContainerMount').execute({
    innerPath: '/mnt/p',
  });
  t.regex(detached, /Detached \/mnt\/p/);
  t.is(
    await kit.tools.get('listContainerMounts').execute(),
    'No runtime container binds are attached.',
  );
});

test('releaseSession pushes the shrunken set to an armed survivor of a shared client', async t => {
  const h = makeHarness();
  const registrar = h.makeRegistrar();
  const { sets, client } = h.makeClient();
  const kitA = registrar.makeSessionKit({
    sessionId: 'a',
    sessionGuest: h.makeGuest(new Map([['data', 'cap-d']])),
  });
  const kitB = registrar.makeSessionKit({
    sessionId: 'b',
    sessionGuest: h.makeGuest(new Map()),
  });
  await kitA.arm({ clientKey: 'ck', client });
  await kitB.arm({ clientKey: 'ck', client });
  await kitA.attach({ petName: 'data', innerPath: '/mnt/d' });
  t.is(sets.length, 1);

  // Session b stays armed on the shared client, so dropping a's
  // last-reference attach must recreate the surviving client's container
  // without the bind, then release the bridge.
  await registrar.releaseSession('a');
  t.is(sets.length, 2);
  t.deepEqual(sets[1], []);
  t.is(h.releaseCalls.length, 1);
});

test('malformed persisted records are dropped on load and never replayed', async t => {
  const h = makeHarness();
  h.names.set(
    h.journalName(0n),
    harden({
      version: 1,
      sequence: 0n,
      records: harden([
        persistedRecord({
          clientKey: 'ck',
          capId: 'c1',
          innerPath: '/mnt/good',
          petName: 'ws',
        }),
        {
          ...persistedRecord({
            clientKey: 'ck',
            capId: 'c2',
            innerPath: '/mnt/escape',
            petName: 'x',
          }),
          innerPath: '/workspace', // escapes /mnt/
        },
        {
          ...persistedRecord({
            clientKey: 'ck',
            capId: 'c3',
            innerPath: '/mnt/y',
            petName: 'y',
          }),
          mode: 'rwx', // bad mode
        },
        {
          // A well-formed record carrying someone else's key: accepting it
          // would collapse two binds onto one bridge, so /mnt/stolen would
          // serve /mnt/good's capability.
          ...persistedRecord({
            clientKey: 'ck',
            capId: 'c4',
            innerPath: '/mnt/stolen',
            petName: 'z',
          }),
          key: attachKeyFor('ck', 'c1', '/mnt/good'),
        },
        'not-a-record',
      ]),
    }),
  );
  const registrar = h.makeRegistrar();
  const { sets, client } = h.makeClient();
  const kit = registrar.makeSessionKit({
    sessionId: 's1',
    sessionGuest: h.makeGuest(new Map()),
  });
  await kit.arm({ clientKey: 'ck', client });
  t.is(sets.length, 1);
  t.deepEqual(
    sets[0].map(extra => extra.innerPath),
    ['/mnt/good'],
  );
  t.deepEqual(
    (await kit.list()).map(record => record.innerPath),
    ['/mnt/good'],
  );
});

test('one unbridgeable record does not wedge the rest, and heals on a later push', async t => {
  const h = makeHarness();
  // Two persisted records; the second one's cap cannot be bridged this boot.
  h.names.set(
    h.journalName(0n),
    harden({
      version: 1,
      sequence: 0n,
      records: harden([
        persistedRecord({
          clientKey: 'ck',
          capId: 'cap-ok',
          innerPath: '/mnt/ok',
          petName: 'ok',
        }),
        persistedRecord({
          clientKey: 'ck',
          capId: 'cap-bad',
          innerPath: '/mnt/bad',
          petName: 'bad',
        }),
      ]),
    }),
  );
  h.failCapIds.add('cap-bad');
  const registrar = h.makeRegistrar();
  const { sets, client } = h.makeClient();
  const guest = h.makeGuest(new Map([['third', 'cap-3']]));
  const kit = registrar.makeSessionKit({
    sessionId: 's1',
    sessionGuest: guest,
  });

  // Replay: the bad record is skipped with a warning; the good one still
  // reaches the container.
  await kit.arm({ clientKey: 'ck', client });
  t.is(sets.length, 1);
  t.deepEqual(
    sets[0].map(extra => extra.innerPath),
    ['/mnt/ok'],
  );

  // Once the cap becomes bridgeable again, the next push retries it (the
  // recorded signature covered only what was actually pushed).
  h.failCapIds.delete('cap-bad');
  await kit.attach({ petName: 'third', innerPath: '/mnt/third' });
  t.is(sets.length, 2);
  t.deepEqual(sets[1].map(extra => extra.innerPath).sort(), [
    '/mnt/bad',
    '/mnt/ok',
    '/mnt/third',
  ]);
});

test('a failed journal write is reported and leaves the previous snapshot intact', async t => {
  const h = makeHarness();
  const registrar = h.makeRegistrar();
  const { sets, client } = h.makeClient();
  const kit = registrar.makeSessionKit({
    sessionId: 's1',
    sessionGuest: h.makeGuest(
      new Map([
        ['a', 'cap-a'],
        ['b', 'cap-b'],
      ]),
    ),
  });
  await kit.arm({ clientKey: 'ck', client });
  await kit.attach({ petName: 'a', innerPath: '/mnt/a' });
  t.deepEqual(
    /** @type {any[]} */ (h.storedRecords()).map(record => record.innerPath),
    ['/mnt/a'],
  );

  // The next petstore write fails. The attach must FAIL — the old code
  // removed the single registry name before storing, so a failed store
  // erased the already-committed /mnt/a record and still reported success.
  h.failStoresAfter(0);
  await t.throwsAsync(() => kit.attach({ petName: 'b', innerPath: '/mnt/b' }), {
    message: /petstore write failed/,
  });
  // The previous snapshot survives, and it is still the whole truth.
  t.deepEqual(
    /** @type {any[]} */ (h.storedRecords()).map(record => record.innerPath),
    ['/mnt/a'],
  );
  // Memory did not keep the record the journal refused, so `list` does not
  // promise a bind that would vanish on the next restart.
  t.deepEqual(
    (await kit.list()).map(record => record.innerPath),
    ['/mnt/a'],
  );
  // And the bridge minted for the refused attach was released rather than
  // left serving the capability with nothing referencing it.
  t.is(h.bridgeCalls.length, 2);
  t.deepEqual(h.releaseCalls, [h.bridgeCalls[1].key]);
  // The container was never told about the refused bind.
  t.is(sets.length, 1);
  t.deepEqual(
    sets[0].map(extra => extra.innerPath),
    ['/mnt/a'],
  );
});

test('concurrent attaches at one innerPath serialize; the loser is refused', async t => {
  const h = makeHarness();
  const registrar = h.makeRegistrar();
  const { sets, client } = h.makeClient();
  const guest = h.makeGuest(
    new Map([
      ['first', 'cap-1'],
      ['second', 'cap-2'],
    ]),
  );
  const kit = registrar.makeSessionKit({
    sessionId: 's1',
    sessionGuest: guest,
  });
  await kit.arm({ clientKey: 'ck', client });

  // Both calls validate against an empty record set before either persists.
  // Without the registrar lock the second would slip its record in behind the
  // first's bridge mint, leaving two binds at one innerPath — which fails
  // every later provision.
  const [first, second] = await Promise.allSettled([
    kit.attach({ petName: 'first', innerPath: '/mnt/race' }),
    kit.attach({ petName: 'second', innerPath: '/mnt/race' }),
  ]);
  t.is(first.status, 'fulfilled');
  t.is(second.status, 'rejected');
  t.regex(
    /** @type {PromiseRejectedResult} */ (second).reason.message,
    /already bound to a different capability/,
  );
  t.deepEqual(
    /** @type {any[]} */ (h.storedRecords()).map(record => record.innerPath),
    ['/mnt/race'],
  );
  t.is(sets[sets.length - 1].length, 1);
});

test('re-arming a client identity with a fresh presence replays onto it', async t => {
  const h = makeHarness();
  const registrar = h.makeRegistrar();
  const first = h.makeClient();
  const kitA = registrar.makeSessionKit({
    sessionId: 'a',
    sessionGuest: h.makeGuest(new Map([['data', 'cap-d']])),
  });
  await kitA.arm({ clientKey: 'ck', client: first.client });
  await kitA.attach({ petName: 'data', innerPath: '/mnt/d' });
  t.is(first.sets.length, 1);

  // The client formula's worker restarted, so the same client identity now
  // resolves to a DIFFERENT presence with an empty bind set of its own. The
  // push signature is keyed by identity, so a stale signature would dedupe
  // the replay away and bring the new container up with no binds.
  const second = h.makeClient();
  const kitB = registrar.makeSessionKit({
    sessionId: 'b',
    sessionGuest: h.makeGuest(new Map()),
  });
  await kitB.arm({ clientKey: 'ck', client: second.client });
  t.is(second.sets.length, 1);
  t.deepEqual(
    second.sets[0].map(extra => extra.innerPath),
    ['/mnt/d'],
  );
});

test('a shared bind does not disclose the other session’s pet name', async t => {
  const h = makeHarness();
  const registrar = h.makeRegistrar();
  const { client } = h.makeClient();
  const kitA = registrar.makeSessionKit({
    sessionId: 'a',
    sessionGuest: h.makeGuest(new Map([['my-secret-repo', 'cap-shared']])),
  });
  const kitB = registrar.makeSessionKit({
    sessionId: 'b',
    sessionGuest: h.makeGuest(new Map([['borrowed', 'cap-shared']])),
  });
  const kitC = registrar.makeSessionKit({
    sessionId: 'c',
    sessionGuest: h.makeGuest(new Map()),
  });
  await kitA.arm({ clientKey: 'ck', client });
  await kitB.arm({ clientKey: 'ck', client });
  await kitC.arm({ clientKey: 'ck', client });

  await kitA.attach({ petName: 'my-secret-repo', innerPath: '/mnt/s' });
  // B joins the same (capId, innerPath) under its OWN name, and is told its
  // own name back rather than A's.
  const joined = await kitB.attach({
    petName: 'borrowed',
    innerPath: '/mnt/s',
  });
  t.is(joined.petName, 'borrowed');
  t.is(joined.sessions, 2);

  // C holds nothing. It can see that something is bound at /mnt/s — the
  // container view is shared and no lie is worth telling about it — but not
  // what anyone else called it.
  const [seen] = await kitC.list();
  t.like(seen, { innerPath: '/mnt/s', mode: 'rw', heldByThisSession: false });
  t.false('petName' in seen);
  t.false('capId' in seen);
});
