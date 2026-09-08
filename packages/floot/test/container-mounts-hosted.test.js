// @ts-check

// The floot factory's hosted session path drives the container-mount
// registrar (designs/runtime-container-fs-mount.md): a session's persisted
// binds are declared as `containerMounts` on the backend session it creates,
// an attach made through the session tool recreates that backend session
// with the new declaration once the tool call has settled, a detach
// recreates without it, and deleting the session releases its bridges.
//
// The backend factory, the bridge provider and the daemon host are fakes;
// the registrar, the adapter, the tool catalog and the factory are real.

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { Far } from '@endo/far';

import { make } from '../agent.js';

/**
 * A world with one floot session on a fake hosted backend. The backend
 * records every `create` spec and can refuse to terminate once, the way a
 * real one does under an unsettled Endo tool call.
 *
 * @param {{ refuseTerminateOnce?: boolean }} [options]
 */
const makeWorld = ({ refuseTerminateOnce = false } = {}) => {
  // One inbox per factory that follows the guest: a buffered reader streams
  // at most once, and the restart test builds two factories over one guest.
  /** @type {ReturnType<typeof makeBufferedReader>[]} */
  const inboxes = [];
  const closeInboxes = () => {
    for (const inbox of inboxes.splice(0)) inbox.close();
  };
  /** @type {Map<string, unknown>} */
  const guestStore = new Map();
  guestStore.set('user', harden({}));
  // The capabilities the session holds and may attach: the fake host
  // resolves each by pet name to a formula id.
  const capNames = ['project', 'notes', 'archive', 'scratch'];
  for (const name of capNames) {
    guestStore.set(name, harden({ kind: 'mount-cap' }));
  }
  const guest = Far('TestGuest', {
    has: name => guestStore.has(name),
    lookup: name => guestStore.get(name),
    storeValue: (value, name) => {
      guestStore.set(name, value);
    },
    remove: name => {
      guestStore.delete(name);
    },
    list: prefix => harden(prefix === 'tools' ? [] : [...guestStore.keys()]),
    locate: () => 'test-locator',
    identify: (...path) => {
      const name = path.join('/');
      return capNames.includes(name) ? `formula-${name}` : undefined;
    },
    followMessages: () => {
      const inbox = makeBufferedReader();
      inboxes.push(inbox);
      return inbox.reader;
    },
  });

  /** @type {Array<{ spec: any, admin: any }>} */
  const creates = [];
  /** The index of the backend session each turn's `send` reached. */
  /** @type {number[]} */
  const sends = [];
  /** @type {string[]} */
  const terminated = [];
  let refusals = refuseTerminateOnce ? 1 : 0;
  /** @type {Promise<void> | undefined} */
  let createGate;
  let rejectDeclared = false;
  let rejectEveryCreate = false;
  /** Destinations whose declaration the sandbox will not attest. */
  const rejectDestinations = new Set();
  /** @type {any} */
  let hostedTools;
  const backend = Far('TestBackend', {
    describe: () =>
      harden({
        id: 'test',
        title: 'Test',
        kind: 'hosted',
        continuity: 'explicit',
        toolOwnership: 'endo',
      }),
    /**
     * @param {{ sessionId: string, containerMounts?: any[] }} spec
     * @param {any} toolSet
     */
    create: async (spec, toolSet) => {
      hostedTools = toolSet;
      const index = creates.length;
      const admin = Far('TestAdmin', {
        terminate: async () => {
          if (refusals > 0) {
            refusals -= 1;
            throw Error('Codex session has 1 unsettled Endo tool call(s)');
          }
          terminated.push(spec.sessionId);
        },
      });
      // Recorded before the gate, so a test can see a create in flight.
      creates.push({ spec, admin });
      if (createGate) await createGate;
      if (rejectEveryCreate) {
        throw Error('hosted backend is unavailable');
      }
      const declaredHere = spec.containerMounts || [];
      if (
        (rejectDeclared && declaredHere.length > 0) ||
        declaredHere.some((/** @type {any} */ attach) =>
          rejectDestinations.has(attach.destination),
        )
      ) {
        throw Error('slice policy attestation failed: attach not proved');
      }
      return harden({
        run: Far('TestRun', {
          send: () => {
            sends.push(index);
            const events = makeBufferedReader();
            events.push(harden({ type: 'end' }));
            events.close();
            return events.reader;
          },
          interrupt: () => undefined,
          acknowledge: () => undefined,
        }),
        admin,
      });
    },
    destroy: () => undefined,
  });

  /** @type {Array<{ key: string, capId: string, mode: string }>} */
  const bridged = [];
  /** @type {string[]} */
  const released = [];
  /** @type {((key: string) => Promise<void> | void) | undefined} */
  let onRelease;
  const bridgeProvider = Far('TestBridgeProvider', {
    provideContainerMountBridge: ({ key, capId, mode }) => {
      bridged.push({ key, capId, mode });
      return harden({
        mountCap: harden({ kind: 'daemon-mount', key }),
        handle: Far('Handle', { unmount: async () => undefined }),
        mountPoint: `/host/mounts/claude-attach-${key}`,
      });
    },
    releaseContainerMountBridge: async key => {
      released.push(key);
      // A hook inside the registrar lock a detach holds: the one place a
      // test can act while a shed is mid-flight.
      if (onRelease) await onRelease(key);
    },
  });

  /** @type {Map<string, unknown>} */
  const hostStore = new Map();
  hostStore.set(
    'floot-sessions',
    harden([
      {
        id: 'one',
        title: 'One',
        createdAt: 1,
        presetId: 'general',
        lifecycle: 'ready',
        backendId: 'test',
        modelId: 'm',
      },
    ]),
  );
  hostStore.set('codex-backend', backend);
  hostStore.set('container-mount-bridge', bridgeProvider);
  hostStore.set('session-agent-one', guest);
  const host = Far('TestHost', {
    list: () => harden([...hostStore.keys()]),
    has: name => hostStore.has(name),
    lookup: name => hostStore.get(name),
    provideGuest: () => undefined,
    storeValue: (value, name) => {
      if (hostStore.has(name)) throw Error(`cannot overwrite ${name}`);
      hostStore.set(name, value);
    },
    remove: name => {
      hostStore.delete(name);
    },
  });
  return {
    host,
    hostStore,
    closeInboxes,
    creates,
    sends,
    terminated,
    bridged,
    released,
    hostedTools: () => hostedTools,
    /**
     * Hold every backend create until the returned function is called.
     */
    holdCreates: () => {
      /** @type {() => void} */
      let release = () => {};
      createGate = new Promise(resolve => {
        release = resolve;
      });
      return () => {
        createGate = undefined;
        release();
      };
    },
    /** Make the backend refuse any create that declares an attach. */
    rejectDeclaredCreates: () => {
      rejectDeclared = true;
    },
    /**
     * Make the backend refuse only creates declaring this destination, so a
     * shed can be provoked without condemning every later bind too.
     *
     * @param {string} destination
     */
    rejectAttachAt: destination => {
      rejectDestinations.add(destination);
    },
    /** Make every backend create fail, mounts or not. */
    rejectAllCreates: () => {
      rejectEveryCreate = true;
    },
    /** @param {(key: string) => Promise<void> | void} hook */
    onBridgeRelease: hook => {
      onRelease = hook;
    },
    /** The inner paths the registrar's newest journal snapshot records. */
    records: () => {
      const journal = [...hostStore.keys()]
        .filter(name => name.startsWith('floot-container-mounts-v1-'))
        .sort();
      const latest = /** @type {any} */ (hostStore.get(journal.at(-1) || ''));
      return [...(latest?.records || [])].map(
        (/** @type {any} */ record) => record.innerPath,
      );
    },
    /** The attaches the most recent backend session was created with. */
    lastDeclared: () =>
      (creates[creates.length - 1]?.spec.containerMounts || []).map(
        (/** @type {any} */ attach) => ({
          destination: attach.destination,
          mode: attach.mode,
        }),
      ),
  };
};

/**
 * A turn runs a session's tool loop; the backend's fake `send` ends at once,
 * so this only serves to make the factory build the agent and reach the
 * backend once.
 *
 * @param {any} factory
 */
const runTurn = async factory => {
  const session = await E(factory).getSession('one');
  const turn = await E(session).startTurn('hello');
  /** @type {any[]} */
  const events = [];
  for await (const event of iterateReader(await E(turn).watch())) {
    events.push(event);
  }
  return events;
};

/** @param {number} ms */
const delay = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/**
 * Wait, bounded, for a condition the adapter reaches on its own schedule.
 *
 * @param {() => boolean} condition
 * @param {() => string} describe - what was being waited for, on timeout.
 */
const until = async (condition, describe) => {
  await null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    // eslint-disable-next-line no-await-in-loop
    await delay(10);
  }
  throw Error(`timed out waiting for ${describe()}`);
};

/**
 * Wait until the fake backend has been created `count` times.
 *
 * @param {ReturnType<typeof makeWorld>} world
 * @param {number} count
 */
const untilCreates = (world, count) =>
  until(
    () => world.creates.length >= count,
    () => `${count} backend creates; saw ${world.creates.length}`,
  );

test('the mount tools reach a hosted session and an attach recreates it with the declaration', async t => {
  t.timeout(10_000);
  const world = makeWorld({ refuseTerminateOnce: true });
  const factory = make(world.host);
  t.teardown(async () => {
    world.closeInboxes();
    await E(factory).deleteSession('one');
  });
  await runTurn(factory);
  t.is(world.creates.length, 1);
  t.deepEqual(world.lastDeclared(), []);

  // The tools are in the pinned catalog the backend was handed.
  const catalog = await E(world.hostedTools()).describe();
  const names = catalog.dynamicTools.map(
    (/** @type {any} */ tool) => tool.name,
  );
  t.true(names.includes('attachContainerMount'));
  t.true(names.includes('listContainerMounts'));
  t.true(names.includes('detachContainerMount'));

  // The backend calls the tool the way a model would. Possession is proved
  // against the session guest, the bridge is minted, and the recreate is
  // scheduled — it cannot run inside this call, because the backend refuses
  // to stop under an unsettled tool call (the fake refuses once, as a real
  // one does until the result is back).
  const reply = await E(world.hostedTools()).execute('attachContainerMount', {
    petName: 'project',
    innerPath: '/mnt/project',
  });
  t.regex(reply, /Attached "project" at \/mnt\/project \(rw\)/);
  t.deepEqual(world.bridged, [
    { key: world.bridged[0].key, capId: 'formula-project', mode: 'rw' },
  ]);
  await untilCreates(world, 2);
  t.deepEqual(world.terminated, ['one']);
  // The successor was created with the attach declared, by the bridge's
  // host mountpoint and the registrar's key.
  const declared = world.creates[1].spec.containerMounts;
  t.deepEqual(declared, [
    {
      key: world.bridged[0].key,
      source: `/host/mounts/claude-attach-${world.bridged[0].key}`,
      destination: '/mnt/project',
      mode: 'rw',
    },
  ]);

  // A detach recreates without it and releases the bridge.
  const detached = await E(world.hostedTools()).execute(
    'detachContainerMount',
    { innerPath: '/mnt/project' },
  );
  t.regex(detached, /Detached \/mnt\/project/);
  await untilCreates(world, 3);
  t.deepEqual(world.lastDeclared(), []);
  t.deepEqual(world.released, [world.bridged[0].key]);
});

test('a bind declared during a recreate is applied by one more, and a turn sent meanwhile waits for the successor', async t => {
  t.timeout(10_000);
  const world = makeWorld();
  const factory = make(world.host);
  t.teardown(async () => {
    world.closeInboxes();
    await E(factory).deleteSession('one');
  });
  await runTurn(factory);
  t.deepEqual(world.sends, [0]);

  const release = world.holdCreates();
  await E(world.hostedTools()).execute('attachContainerMount', {
    petName: 'project',
    innerPath: '/mnt/project',
  });
  await untilCreates(world, 2);
  t.deepEqual(world.lastDeclared(), [
    { destination: '/mnt/project', mode: 'rw' },
  ]);

  // The second attach lands while the first recreate's create is in flight,
  // and a turn is sent while the sandbox has no live backend session.
  await E(world.hostedTools()).execute('attachContainerMount', {
    petName: 'notes',
    innerPath: '/mnt/notes',
    mode: 'ro',
  });
  const turn = runTurn(factory);
  await delay(50);
  t.deepEqual(world.sends, [0], 'the turn waits instead of failing');
  t.is(world.creates.length, 2);

  release();
  await turn;
  // Exactly one further recreate, declaring both; not one per attach and
  // not zero.
  t.is(world.creates.length, 3);
  t.deepEqual(world.lastDeclared(), [
    { destination: '/mnt/project', mode: 'rw' },
    { destination: '/mnt/notes', mode: 'ro' },
  ]);
  t.deepEqual(world.sends, [0, 2], 'the turn ran on the current successor');
  t.deepEqual(world.terminated, ['one', 'one']);
});

test('a persisted bind is declared on the first create after a restart, without a recreate', async t => {
  t.timeout(10_000);
  const world = makeWorld();
  const first = make(world.host);
  await runTurn(first);
  await E(world.hostedTools()).execute('attachContainerMount', {
    petName: 'project',
    innerPath: '/mnt/project',
    mode: 'ro',
  });
  await untilCreates(world, 2);
  t.deepEqual(world.lastDeclared(), [
    { destination: '/mnt/project', mode: 'ro' },
  ]);

  // "Daemon restart": a fresh factory over the same host petstore. The
  // registrar replays its journal into the adapter BEFORE the first create,
  // so that create already declares the bind — no terminate, no recreate.
  const restarted = make(world.host);
  t.teardown(async () => {
    world.closeInboxes();
    await E(restarted).deleteSession('one');
  });
  const before = world.terminated.length;
  await runTurn(restarted);
  t.is(world.creates.length, 3);
  t.deepEqual(world.lastDeclared(), [
    { destination: '/mnt/project', mode: 'ro' },
  ]);
  t.is(world.terminated.length, before);
  // The bridge was re-minted at the same deterministic key.
  t.is(world.bridged.length, 2);
  t.is(world.bridged[1].key, world.bridged[0].key);
});

test('deleting the session releases its bridges after the backend is gone', async t => {
  t.timeout(10_000);
  const world = makeWorld();
  const factory = make(world.host);
  await runTurn(factory);
  await E(world.hostedTools()).execute('attachContainerMount', {
    petName: 'project',
    innerPath: '/mnt/project',
  });
  await untilCreates(world, 2);
  world.closeInboxes();
  await E(factory).deleteSession('one');
  t.deepEqual(world.released, [world.bridged[0].key]);
  // The backend was terminated before the bridge was released, so no
  // container still bound the mountpoint being unmounted.
  t.true(world.terminated.length >= 2);
  // Nothing of the session's binds survives in the journal.
  const journal = [...world.hostStore.keys()].filter(name =>
    name.startsWith('floot-container-mounts-v1-'),
  );
  const latest = /** @type {any} */ (
    world.hostStore.get(journal.sort().at(-1) || '')
  );
  t.deepEqual([...(latest?.records || [])], []);
});

test('a recreate the sandbox refuses drops the bind, releases its bridge, and reports on the next turn', async t => {
  t.timeout(10_000);
  const world = makeWorld();
  const factory = make(world.host);
  t.teardown(async () => {
    world.closeInboxes();
    await E(factory).deleteSession('one');
  });
  await runTurn(factory);
  world.rejectDeclaredCreates();

  // The attach itself succeeds — possession is proved and the bridge is
  // minted — and only the deferred recreate learns the sandbox will not
  // attest the bind.
  const reply = await E(world.hostedTools()).execute('attachContainerMount', {
    petName: 'project',
    innerPath: '/mnt/project',
  });
  t.regex(reply, /Attached "project" at \/mnt\/project/);
  // The refused create, then the fallback without the bind.
  await untilCreates(world, 3);
  await until(
    () => world.released.length === 1,
    () => 'the dropped bind’s bridge to be released',
  );
  t.deepEqual(world.lastDeclared(), []);
  t.deepEqual(world.released, [world.bridged[0].key]);
  // No record claims a bind the container lacks.
  t.is(
    await E(world.hostedTools()).execute('listContainerMounts', {}),
    'No runtime container binds are attached.',
  );

  // The next turn carries the report, once; the one after runs normally on
  // the fallback session.
  const outcome = await runTurn(factory).then(
    events => ({ events }),
    error => ({ error: error.message }),
  );
  t.regex(
    JSON.stringify(outcome),
    /could not be recreated with \/mnt\/project and the bind\(s\) were dropped/,
  );
  await runTurn(factory);
  t.is(world.sends.at(-1), 2);
});

test('a bind that lands while a refused recreate sheds is applied, not stranded', async t => {
  t.timeout(20_000);
  const world = makeWorld();
  const factory = make(world.host);
  t.teardown(async () => {
    world.closeInboxes();
    await E(factory).deleteSession('one');
  });
  await runTurn(factory);
  /**
   * @param {string} petName
   * @param {string} innerPath
   */
  const attach = (petName, innerPath) =>
    E(world.hostedTools()).execute('attachContainerMount', {
      petName,
      innerPath,
    });

  // Two binds the sandbox attests, so the shed below has two to walk and
  // frees the registrar lock between them.
  await attach('project', '/mnt/project');
  await untilCreates(world, 2);
  await attach('notes', '/mnt/notes');
  await untilCreates(world, 3);

  // A third bind the sandbox will not attest. Its recreate is refused, so
  // the shed drops all three — and while it releases the first bridge, a
  // fourth attach lands and takes the lock the shed has just let go. Its
  // own recreate is suppressed (the shed still has the floor) but the
  // registrar has already recorded it as pushed, so nothing offers it
  // again: a declaration wiped wholesale at the end of the shed leaves
  // that record with no bind behind it, permanently.
  world.rejectAttachAt('/mnt/archive');
  /** @type {Promise<string> | undefined} */
  let landed;
  world.onBridgeRelease(() => {
    if (!landed) landed = attach('scratch', '/mnt/scratch');
  });
  await attach('archive', '/mnt/archive');
  await until(
    () => landed !== undefined,
    () => 'the fourth attach to land inside the shed',
  );
  t.regex(
    String(await landed),
    /Attached "scratch"/,
    'the mid-shed attach itself succeeded',
  );

  // Whatever the interleaving, one invariant decides it: the records and
  // the container agree. A record with no bind behind it is the failure.
  await until(
    () => {
      const destinations = new Set(
        world.lastDeclared().map(entry => entry.destination),
      );
      const records = world.records();
      return (
        records.length === destinations.size &&
        records.every(record => destinations.has(record))
      );
    },
    () =>
      `the records ${JSON.stringify(world.records())} to match the container's ${JSON.stringify(world.lastDeclared())}`,
  );
  t.deepEqual(world.records(), ['/mnt/scratch']);
});

test('a backend that fails for its own reasons is not reported as a mount refusal', async t => {
  t.timeout(10_000);
  const world = makeWorld();
  const factory = make(world.host);
  t.teardown(async () => {
    world.closeInboxes();
    await E(factory).deleteSession('one');
  });
  await runTurn(factory);
  await E(world.hostedTools()).execute('attachContainerMount', {
    petName: 'project',
    innerPath: '/mnt/project',
  });
  await untilCreates(world, 2);

  // The backend is down. Detaching leaves nothing declared, so the recreate
  // that fails cannot have failed because of a mount: the failure is the
  // backend's own. Shedding here would report a fiction — binds that are
  // not there — and create twice against a backend already failing.
  world.rejectAllCreates();
  const createsBefore = world.creates.length;
  await E(world.hostedTools()).execute('detachContainerMount', {
    innerPath: '/mnt/project',
  });
  await untilCreates(world, createsBefore + 1);
  await delay(200);
  t.is(
    world.creates.length,
    createsBefore + 1,
    'one create attempt, not a shed and a second try',
  );
  const events = await runTurn(factory).then(
    turnEvents => JSON.stringify(turnEvents),
    error => error.message,
  );
  t.notRegex(events, /bind\(s\) were dropped/);
  t.regex(events, /hosted backend is unavailable/);
});
