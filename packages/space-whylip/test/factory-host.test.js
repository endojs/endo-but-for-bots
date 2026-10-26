// @ts-check

import '@endo/init/debug.js';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { makeFactoryHostAdapter } from '../src/factory-host-caplet.js';

const driverUrl = new URL('../../fae/driver.js', import.meta.url).href;

const makeFixture = () => {
  /** @type {Array<{method: string, args: any[]}>} */
  const calls = [];
  const host = Object.fromEntries(
    [
      'has',
      'lookup',
      'locate',
      'provideGuest',
      'makeUnconfined',
      'copy',
      'cancel',
      'remove',
      'list',
    ].map(method => [
      method,
      async (...args) => {
        calls.push({ method, args });
        return method === 'has'
          ? true
          : method === 'list'
            ? ['whylip-story', 'profile-for-whylip-story', 'other', '@endo']
            : undefined;
      },
    ]),
  );
  return { adapter: makeFactoryHostAdapter(host), calls };
};

test('factory adapter permits the exact main-story and background-driver provisioning sequence', async t => {
  await null;
  const { adapter, calls } = makeFixture();
  for (const name of ['whylip-node-formula-story', 'whylip-formula-12']) {
    const profile = `profile-for-${name}`;
    const driverProfile = `profile-for-${name}-driver-handle`;
    const result = `${name}-driver`;
    // These sequential calls mirror Fae factory.provision().
    // eslint-disable-next-line no-await-in-loop
    await E(adapter).has(result);
    // eslint-disable-next-line no-await-in-loop
    await E(adapter).provideGuest(name, harden({ agentName: profile }));
    // eslint-disable-next-line no-await-in-loop
    await E(adapter).provideGuest(
      `${name}-driver-handle`,
      harden({ agentName: driverProfile }),
    );
    // eslint-disable-next-line no-await-in-loop
    await E(adapter).lookup(profile);
    // eslint-disable-next-line no-await-in-loop
    await E(adapter).locate(profile);
    // eslint-disable-next-line no-await-in-loop
    await E(adapter).makeUnconfined(
      '@main',
      driverUrl,
      harden({
        powersName: driverProfile,
        resultName: result,
        env: { FAE_SYSTEM_PROMPT: 'Tell the story.', FAE_SUBAGENT_PROMPT: '' },
      }),
    );
    // eslint-disable-next-line no-await-in-loop
    await E(adapter).copy(harden([result]), harden(['@pins', result]));
  }
  t.is(calls.length, 14);
  t.deepEqual(calls[5].args, [
    '@main',
    driverUrl,
    {
      powersName: 'profile-for-whylip-node-formula-story-driver-handle',
      resultName: 'whylip-node-formula-story-driver',
      env: { FAE_SYSTEM_PROMPT: 'Tell the story.', FAE_SUBAGENT_PROMPT: '' },
    },
  ]);
});

test('factory adapter rejects host names, namespace escape, introductions, arbitrary modules, and unrelated pins before forwarding', async t => {
  await null;
  const { adapter, calls } = makeFixture();
  const good = harden({
    powersName: 'profile-for-whylip-story-driver-handle',
    resultName: 'whylip-story-driver',
    env: { FAE_SYSTEM_PROMPT: '', FAE_SUBAGENT_PROMPT: '' },
  });
  const attempts = [
    () => E(adapter).lookup('@agent'),
    () => E(adapter).lookup('@endo'),
    () => E(adapter).lookup('profile-for-whylip-../root'),
    () => E(adapter).locate('@self'),
    () => E(adapter).has('@pins'),
    () => E(adapter).has('@pins', '@agent'),
    () => E(adapter).cancel('@agent'),
    () => E(adapter).cancel('whylip-story-driver'),
    () => E(adapter).remove('@pins'),
    () => E(adapter).remove('@pins', 'other-driver'),
    () => E(adapter).remove('other'),
    () => E(adapter).lookup('whylip-story-driver'),
    () =>
      E(adapter).provideGuest(
        'ordinary-user',
        harden({ agentName: 'profile-for-ordinary-user' }),
      ),
    () =>
      E(adapter).provideGuest('whylip-story', harden({ agentName: '@agent' })),
    () =>
      E(adapter).provideGuest(
        'whylip-story',
        harden({
          agentName: 'profile-for-whylip-story',
          introducedNames: { '@agent': 'host' },
        }),
      ),
    () => E(adapter).makeUnconfined('@node', driverUrl, good),
    () => E(adapter).makeUnconfined('@main', 'file:///tmp/evil.js', good),
    () =>
      E(adapter).makeUnconfined(
        '@main',
        driverUrl,
        harden({ ...good, powersName: '@agent' }),
      ),
    () =>
      E(adapter).makeUnconfined(
        '@main',
        driverUrl,
        harden({
          ...good,
          powersName: 'profile-for-whylip-other-driver-handle',
        }),
      ),
    () =>
      E(adapter).makeUnconfined(
        '@main',
        driverUrl,
        harden({
          ...good,
          env: { FAE_SYSTEM_PROMPT: '', NODE_OPTIONS: '--import=/tmp/evil.js' },
        }),
      ),
    () =>
      E(adapter).makeUnconfined(
        '@main',
        driverUrl,
        harden({ ...good, introducedNames: {} }),
      ),
    () => E(adapter).copy(harden(['@agent']), harden(['@pins', '@agent'])),
    () =>
      E(adapter).copy(
        harden(['whylip-story-driver']),
        harden(['@pins', 'other']),
      ),
    () =>
      E(adapter).copy(
        harden(['whylip-story-driver']),
        harden(['other', 'whylip-story-driver']),
      ),
  ];
  for (const attempt of attempts) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(attempt);
  }
  t.deepEqual(calls, []);
  // This is an explicit small interface, not a proxy to the underlying host.
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter));
  for (const name of ['storeLocator', 'provideHost', 'send', 'makeDirectory'])
    t.false(methods.includes(name));
});

test('factory adapter permits bounded ownership probes and rollback without general host access', async t => {
  await null;
  const { adapter, calls } = makeFixture();
  t.true(await E(adapter).has('whylip-story'));
  t.true(await E(adapter).has('whylip-story-spawner-handle'));
  t.true(await E(adapter).has('@pins', 'whylip-story-driver'));
  await E(adapter).locate('whylip-story');
  t.deepEqual(await E(adapter).list(), ['whylip-story']);
  await E(adapter).cancel('profile-for-whylip-story-driver-handle');
  await E(adapter).remove('profile-for-whylip-story-driver-handle');
  await E(adapter).remove('whylip-story-driver');
  await E(adapter).remove('@pins', 'whylip-story-driver');
  t.is(calls.length, 9);
});

test('the upstream Fae provisioner can create, reconnect, and roll back through the scoped adapter', async t => {
  // Exercise the actual upstream collision probes and rollback, not a copy of
  // their sequence. The fake host records formulas without starting a driver.
  // eslint-disable-next-line import/no-relative-packages
  const { make: makeFactory } = await import('../../fae/agent.js');
  /** @type {Map<string, any>} */
  const bindings = new Map([['user-document', 'keep']]);
  const grants = [];
  const cancelled = [];
  let launches = 0;
  let failLaunch = true;
  const host = {
    has: (...path) => bindings.has(path.join('/')),
    lookup: name => bindings.get(name),
    locate: name => `locator:${name}`,
    list: () => [...bindings.keys()],
    cancel: name => {
      cancelled.push(name);
    },
    remove: (...path) => {
      bindings.delete(path.join('/'));
    },
    provideGuest: (name, { agentName }) => {
      const guest = makeExo(
        'TestGuest',
        M.interface('TestGuest', {
          storeLocator: M.call(M.string(), M.string()).returns(M.undefined()),
        }),
        {
          storeLocator: (key, locator) => {
            grants.push({ name, key, locator });
          },
        },
      );
      bindings.set(name, guest);
      bindings.set(agentName, guest);
      return guest;
    },
    makeUnconfined: (worker, module, options) => {
      launches += 1;
      if (failLaunch) throw Error('launch failed');
      bindings.set(options.resultName, 'driver-formula');
    },
    copy: (from, to) => {
      bindings.set(to.join('/'), bindings.get(from.join('/')));
    },
  };
  const adapter = makeFactoryHostAdapter(host);
  const powers = harden({
    lookup: name => {
      if (name !== 'host-agent') throw Error('Unexpected lookup');
      return adapter;
    },
    has: () => false,
    locate: name => `locator:${name}`,
  });
  const factory = await makeFactory(powers, undefined);
  const options = harden({
    systemPrompt: 'Illustrate only the assigned draft.',
    pin: true,
    maxSubagentDepth: 0,
  });
  await t.throwsAsync(
    E(factory).createAgentCapability('whylip-scope', options),
    { message: 'launch failed' },
  );
  t.deepEqual([...bindings], [['user-document', 'keep']]);
  t.deepEqual(cancelled, [
    'profile-for-whylip-scope-driver-handle',
    'profile-for-whylip-scope',
  ]);
  failLaunch = false;
  const created = await E(factory).createAgentCapability(
    'whylip-scope',
    options,
  );
  const restored = await E(factory).createAgentCapability(
    'whylip-scope',
    options,
  );
  t.is(restored.agent, created.agent);
  t.is(created.locator, 'locator:profile-for-whylip-scope');
  t.is(launches, 2, 'reconnect does not relaunch a completed driver');
  t.is(bindings.get('@pins/whylip-scope-driver'), 'driver-formula');
  t.false(
    grants.some(
      grant => grant.key === 'host-agent' || grant.key === 'subagent-spawner',
    ),
  );
  t.is(bindings.get('user-document'), 'keep');
});
