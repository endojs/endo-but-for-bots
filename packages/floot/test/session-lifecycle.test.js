// @ts-nocheck
import '@endo/init/debug.js';

import test from 'ava';
import path from 'path';
import url from 'url';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { makeEndoClient, purge, start, stop } from '@endo/daemon';

import { makeSessionLifecycle } from '../src/session-lifecycle.js';

const dirname = url.fileURLToPath(new URL('..', import.meta.url)).toString();
const SESSION_ROOT = 'floot-session-guests';

/** @type {Map<string, number>} */
const testNumbers = new Map();

const getConfigDirectoryName = (testTitle, testConfigIndex) => {
  const munged = testTitle.match(/\w+/gu)?.join('-') || '';
  if (!testNumbers.has(testTitle)) testNumbers.set(testTitle, testNumbers.size);
  const testNumber = testNumbers.get(testTitle);
  const nnnn = String(testNumber).padStart(4, '0');
  const letter = (testConfigIndex + 10).toString(36);
  return `${munged.slice(0, 24)}~${nnnn}${letter}`;
};

const makeConfig = (...root) => ({
  statePath: path.join(dirname, 'tmp', ...root, 'state'),
  ephemeralStatePath: path.join(dirname, 'tmp', ...root, 'run'),
  cachePath: path.join(dirname, 'tmp', ...root, 'cache'),
  sockPath:
    process.platform === 'win32'
      ? `\\\\?\\pipe\\endo-floot-${root.join('-')}.sock`
      : path.join(dirname, 'tmp', ...root, 'endo.sock'),
  address: '127.0.0.1:0',
  pets: new Map(),
  values: new Map(),
});

const prepareConfig = async t => {
  const { reject: cancel, promise: cancelled } = makePromiseKit();
  cancelled.catch(() => {});
  const config = makeConfig(getConfigDirectoryName(t.title, t.context.length));
  await purge(config);
  await start(config);
  t.context.push({ cancel, cancelled, config });
  const { getBootstrap, closed } = await makeEndoClient(
    'floot-session-lifecycle-test',
    config.sockPath,
    cancelled,
  );
  closed.catch(() => {});
  const bootstrap = getBootstrap();
  return { config, cancelled, host: E(bootstrap).host() };
};

test.beforeEach(t => {
  t.context = [];
});

test.afterEach.always(async t => {
  const configs = t.context;
  await Promise.allSettled(configs.map(({ config }) => stop(config)));
  for (const { cancel, cancelled } of configs) {
    cancelled.catch(() => {});
    cancel(Error('teardown'));
  }
});

/**
 * @param {object} args
 * @param {object} args.host
 * @param {Array<{ id: string, expiresAt?: number }>} args.initialRegistry
 * @param {number} [args.now]
 * @param {(id: string) => void | Promise<void>} [args.onCleanup]
 * @param {{
 *   sessionGuestsName?: string,
 *   sessionHandleName?: string,
 *   sessionAgentName?: string,
 * }} [args.names]
 */
const makeLifecycleHarness = ({
  host,
  initialRegistry,
  now = 0,
  onCleanup,
  names = {},
}) => {
  let registry = [...initialRegistry];
  const makeLifecycle = () =>
    makeSessionLifecycle({
      host,
      clock: { now: () => now },
      getRegistry: async () => registry,
      removeRegistryEntries: async ids => {
        const idSet = new Set(ids);
        registry = registry.filter(entry => !idSet.has(entry.id));
      },
      onCleanup,
      ...names,
    });
  return {
    makeLifecycle,
    getRegistry: () => registry,
    simulateRegistryCommitWithoutDrop: id => {
      registry = registry.filter(entry => entry.id !== id);
    },
  };
};

test.serial('normal session end completes the durable cleanup', async t => {
  const { host } = await prepareConfig(t);
  const state = makeLifecycleHarness({
    host,
    initialRegistry: [{ id: 'ended' }, { id: 'other' }],
  });
  const lifecycle = state.makeLifecycle();

  await lifecycle.provideSessionGuest('ended');
  await lifecycle.provideSessionGuest('other');
  await lifecycle.endSession('ended');

  t.deepEqual(state.getRegistry(), [{ id: 'other' }]);
  t.false(await E(host).has(SESSION_ROOT, 'ended'));
  t.true(await E(host).has(SESSION_ROOT, 'other'));
});

test.serial(
  'cleanup callbacks run before the guest directory is dropped',
  async t => {
    const { host } = await prepareConfig(t);
    const ordering = [];
    const state = makeLifecycleHarness({
      host,
      initialRegistry: [{ id: 'ordered' }],
      onCleanup: async id => {
        ordering.push(`${id}:callback`);
        t.true(await E(host).has(SESSION_ROOT, id));
      },
    });
    const lifecycle = state.makeLifecycle();

    await lifecycle.provideSessionGuest('ordered');
    await lifecycle.endSession('ordered');
    ordering.push('ordered:dropped');

    t.deepEqual(ordering, ['ordered:callback', 'ordered:dropped']);
    t.false(await E(host).has(SESSION_ROOT, 'ordered'));
  },
);

test.serial(
  'live sessions and host bindings survive another session cleanup',
  async t => {
    const { host } = await prepareConfig(t);
    const state = makeLifecycleHarness({
      host,
      initialRegistry: [{ id: 'ended' }, { id: 'live' }],
    });
    const lifecycle = state.makeLifecycle();

    await lifecycle.provideSessionGuest('ended');
    await lifecycle.provideSessionGuest('live');
    await E(host).storeValue('host-owned', 'host-owned');
    await lifecycle.endSession('ended');

    t.false(await E(host).has(SESSION_ROOT, 'ended'));
    t.true(await E(host).has(SESSION_ROOT, 'live'));
    t.true(await E(host).has('host-owned'));
  },
);

test.serial(
  'expiry sweep routes expired sessions through the same cleanup',
  async t => {
    const { host } = await prepareConfig(t);
    const state = makeLifecycleHarness({
      host,
      now: 100,
      initialRegistry: [
        { id: 'expired', expiresAt: 99 },
        { id: 'live', expiresAt: 101 },
      ],
    });
    const lifecycle = state.makeLifecycle();

    await lifecycle.provideSessionGuest('expired');
    await lifecycle.provideSessionGuest('live');
    const reaped = await lifecycle.sweep();

    t.deepEqual(reaped, ['expired']);
    t.deepEqual(state.getRegistry(), [{ id: 'live', expiresAt: 101 }]);
    t.false(await E(host).has(SESSION_ROOT, 'expired'));
    t.true(await E(host).has(SESSION_ROOT, 'live'));
  },
);

test.serial(
  'a restart sweep reaps a crash orphan after registry commit',
  async t => {
    const { host } = await prepareConfig(t);
    const state = makeLifecycleHarness({
      host,
      initialRegistry: [{ id: 'crashed' }, { id: 'live' }],
    });
    const beforeCrash = state.makeLifecycle();
    await beforeCrash.provideSessionGuest('crashed');
    await beforeCrash.provideSessionGuest('live');

    // The owner persisted the deletion, then died before dropping the guest.
    state.simulateRegistryCommitWithoutDrop('crashed');
    const afterRestart = state.makeLifecycle();
    const reaped = await afterRestart.sweep();

    t.deepEqual(reaped, ['crashed']);
    t.false(await E(host).has(SESSION_ROOT, 'crashed'));
    t.true(await E(host).has(SESSION_ROOT, 'live'));
  },
);

test.serial(
  'legacy session roots migrate through an interrupted move',
  async t => {
    const { host } = await prepareConfig(t);
    const legacyGuest = await E(host).provideGuest('session-legacy', {
      agentName: 'session-agent-legacy',
    });
    const legacyLocator = await E(host).locate('session-legacy');
    const legacyAgentLocator = await E(host).locate('session-agent-legacy');

    // Stage the copy-then-remove midpoint of a cross-directory daemon move.
    await E(host).makeDirectory(SESSION_ROOT);
    await E(host).makeDirectory([SESSION_ROOT, 'legacy']);
    await E(host).copy(['session-legacy'], [SESSION_ROOT, 'legacy', 'handle']);
    await E(host).copy(
      ['session-agent-legacy'],
      [SESSION_ROOT, 'legacy', 'agent'],
    );

    const state = makeLifecycleHarness({
      host,
      initialRegistry: [{ id: 'legacy' }],
    });
    const lifecycle = state.makeLifecycle();
    await lifecycle.provideSessionGuest('legacy');

    t.false(await E(host).has('session-legacy'));
    t.false(await E(host).has('session-agent-legacy'));
    t.true(await E(host).has(SESSION_ROOT, 'legacy', 'handle'));
    t.true(await E(host).has(SESSION_ROOT, 'legacy', 'agent'));
    t.is(
      await E(host).locate(SESSION_ROOT, 'legacy', 'agent'),
      legacyAgentLocator,
    );
    t.is(await E(host).locate(SESSION_ROOT, 'legacy', 'handle'), legacyLocator);
    t.truthy(legacyGuest);

    await lifecycle.endSession('legacy');
    t.false(await E(host).has(SESSION_ROOT, 'legacy'));
  },
);

test.serial('session namespace names are configurable', async t => {
  const { host } = await prepareConfig(t);
  const state = makeLifecycleHarness({
    host,
    initialRegistry: [{ id: 'custom' }],
    names: {
      sessionGuestsName: 'custom-session-guests',
      sessionHandleName: 'custom-handle',
      sessionAgentName: 'custom-agent',
    },
  });
  const lifecycle = state.makeLifecycle();

  await lifecycle.provideSessionGuest('custom');

  t.true(await E(host).has('custom-session-guests', 'custom'));
  t.true(await E(host).has('custom-session-guests', 'custom', 'custom-handle'));
  t.true(await E(host).has('custom-session-guests', 'custom', 'custom-agent'));
  t.false(await E(host).has(SESSION_ROOT));

  await lifecycle.endSession('custom');
  t.false(await E(host).has('custom-session-guests', 'custom'));
});
