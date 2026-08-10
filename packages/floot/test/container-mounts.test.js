// @ts-check
// Runtime container filesystem attach (designs/runtime-container-fs-mount.md):
// innerPath validation, cap possession, ref counting across sessions of a
// shared client, immediate push to the ClaudeClient, last-detach bridge
// teardown, and persistence replay across a simulated daemon restart.
import test from '@endo/ses-ava/prepare-endo.js';

import {
  makeContainerMountRegistrar,
  normalizeInnerPath,
} from '../src/container-mounts.js';

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
  const powers = harden({
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
      if (names.has(name)) throw Error(`cannot overwrite ${name}`);
      names.set(name, value);
    },
  });
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
    bridgeCalls,
    releaseCalls,
    handleUnmounts,
    failCapIds,
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
  // other object.
  t.is(sets[0][0].cap.kind, 'bridged-mount');
  t.is(sets[0][0].cap.key, h.bridgeCalls[0].key);
  t.truthy(sets[0][0].handle);

  // Persisted for replay.
  const stored = /** @type {any[]} */ (h.names.get('floot-container-mounts'));
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
    { message: /hosted Claude session provisioner/ },
  );
  t.false(h.names.has('floot-container-mounts'));
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
  const stored = /** @type {any[]} */ (h.names.get('floot-container-mounts'));
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
  const stored = /** @type {any[]} */ (h.names.get('floot-container-mounts'));
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
  const names = Object.keys(kit.tools);
  t.deepEqual(names.sort(), [
    'attachContainerMount',
    'detachContainerMount',
    'listContainerMounts',
  ]);
  for (const name of names) {
    t.is(kit.tools[name].schema().function.name, name);
  }
  await t.throwsAsync(
    () =>
      kit.tools.attachContainerMount.execute({
        petName: 'workspace',
        innerPath: '/mnt/p',
      }),
    { message: /not available for this session/ },
  );

  await kit.arm({ clientKey: 'ck', client });
  const attached = await kit.tools.attachContainerMount.execute({
    petName: 'workspace',
    innerPath: '/mnt/p',
  });
  t.regex(attached, /Attached "workspace" at \/mnt\/p \(rw\)/);
  const listed = await kit.tools.listContainerMounts.execute();
  t.regex(listed, /\/mnt\/p/);
  const detached = await kit.tools.detachContainerMount.execute({
    innerPath: '/mnt/p',
  });
  t.regex(detached, /Detached \/mnt\/p/);
  t.is(
    await kit.tools.listContainerMounts.execute(),
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
    'floot-container-mounts',
    harden([
      {
        key: 'k1',
        clientKey: 'ck',
        capId: 'c1',
        innerPath: '/mnt/good',
        mode: 'rw',
        petName: 'ws',
        sessionIds: ['s1'],
      },
      {
        key: 'k2',
        clientKey: 'ck',
        capId: 'c2',
        innerPath: '/workspace', // escapes /mnt/
        mode: 'rw',
        petName: 'x',
        sessionIds: ['s1'],
      },
      {
        key: 'k3',
        clientKey: 'ck',
        capId: 'c3',
        innerPath: '/mnt/y',
        mode: 'rwx', // bad mode
        petName: 'y',
        sessionIds: ['s1'],
      },
      'not-a-record',
    ]),
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
    'floot-container-mounts',
    harden([
      {
        key: 'kgood',
        clientKey: 'ck',
        capId: 'cap-ok',
        innerPath: '/mnt/ok',
        mode: 'rw',
        petName: 'ok',
        sessionIds: ['s1'],
      },
      {
        key: 'kbad',
        clientKey: 'ck',
        capId: 'cap-bad',
        innerPath: '/mnt/bad',
        mode: 'rw',
        petName: 'bad',
        sessionIds: ['s1'],
      },
    ]),
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
