// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';
import {
  makeEnvironment,
  assertEnvironmentRecipe,
} from '../src/environment.js';

test.beforeEach(t => t.timeout(5000));

const recipe = harden({
  policy: { allowedCommands: ['sh'], timeoutMs: 1000, maxOutputBytes: 4096 },
  networkPolicy: 'off',
});
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await null; // eslint-disable-line no-await-in-loop
};
/** @param {{ stored?: string, provide?: () => any, remove?: () => any, write?: (text: string) => any }} [options] */
const fixture = async ({ stored, provide, remove, write } = {}) => {
  let text = stored;
  const calls = [];
  const workspace = Far('Workspace', {});
  const nativeShell = Far('NativeShell', {
    exec: async (...args) => {
      calls.push(['exec', ...args]);
      return harden({
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
        signal: null,
        truncated: false,
      });
    },
  });
  const controller = Far('Controller', {
    open: async () => {
      calls.push(['open']);
      return nativeShell;
    },
    stop: async () => {
      calls.push(['stop']);
    },
  });
  const runner = Far('Runner', {
    provideEnvironment: async (id, selected, dependencies) => {
      calls.push([
        'provide',
        id,
        selected,
        await E(dependencies).get('workspace'),
      ]);
      return provide ? provide() : controller;
    },
    removeEnvironmentStorage: async id => {
      calls.push(['remove', id]);
      return remove?.();
    },
  });
  const directory = Far('State', {
    maybeReadText: async () => text,
    writeText: async (_name, value) => {
      if (write) await write(value);
      text = value;
    },
  });
  const resolve = async role => {
    calls.push(['resolve', role]);
    return role === 'runner' ? runner : workspace;
  };
  const owner = await makeEnvironment({
    id: 'exact-id',
    recipe,
    directory,
    resolve,
  });
  return {
    owner,
    calls,
    directory,
    resolve,
    nativeShell,
    getText: () => {
      if (text === undefined) throw Error('Missing lifecycle state');
      return text;
    },
  };
};

test('creation, inspect, and idle restoration remain passive', async t => {
  const f = await fixture();
  t.deepEqual(await E(f.owner.shell).inspect(), recipe.policy);
  t.is((await E(f.owner.admin).inspect()).phase, 'idle');
  const restored = await makeEnvironment({
    id: 'exact-id',
    recipe,
    directory: f.directory,
    resolve: f.resolve,
  });
  t.deepEqual(await E(restored.shell).inspect(), recipe.policy);
  t.deepEqual(f.calls, []);
});

test('intent precedes activation; fixed dependency and Shell result survive stop', async t => {
  const f = await fixture();
  t.is(
    (await E(f.owner.shell).exec('sh', harden(['-c', 'true']))).stdout,
    'ok',
  );
  t.is(JSON.parse(f.getText()).phase, 'active');
  t.deepEqual(
    f.calls.filter(c => c[0] === 'resolve').map(c => c[1]),
    ['runner', 'workspace'],
  );
  await E(f.owner.admin).stop();
  t.is(JSON.parse(f.getText()).phase, 'idle');
  t.is(f.calls.filter(c => c[0] === 'remove').length, 0);
  await E(f.owner.shell).exec('sh', harden([]));
  t.is(f.calls.filter(c => c[0] === 'open').length, 2);
  await f.owner.shutdown();
});

test('unsupported command never resolves native dependencies', async t => {
  const f = await fixture();
  await t.throwsAsync(E(f.owner.shell).exec('bash', harden([])), {
    message: /allowlist/,
  });
  t.deepEqual(f.calls, []);
});

test('cold active intent refuses execution and cannot manufacture stop evidence', async t => {
  const f = await fixture({
    stored: JSON.stringify({ phase: 'active', networkPolicy: 'off' }),
  });
  await t.throwsAsync(E(f.owner.shell).exec('sh', harden([])), {
    message: /operator cleanup/,
  });
  await t.throwsAsync(E(f.owner.admin).stop(), { message: /operator cleanup/ });
  t.deepEqual(f.calls, []);
});

test('failed durable intent publication fences before acquisition', async t => {
  const f = await fixture({
    write: async () => {
      throw Error('lost write ACK');
    },
  });
  await t.throwsAsync(E(f.owner.shell).exec('sh', harden([])), {
    message: /lost write/,
  });
  t.true((await E(f.owner.admin).inspect()).interrupted);
  await t.throwsAsync(E(f.owner.shell).exec('sh', harden([])), {
    message: /operator cleanup/,
  });
  t.deepEqual(f.calls, []);
});

test('stop retains a late inert controller and closes it without opening', async t => {
  const pending = makePromiseKit();
  const f = await fixture({ provide: () => pending.promise });
  const command = E(f.owner.shell).exec('sh', harden([]));
  const commandOutcome = t.throwsAsync(command, { message: /stopped/ });
  await flush();
  let stops = 0;
  const stop = E(f.owner.admin).stop();
  await flush();
  pending.resolve(
    Far('Late', {
      open: () => {
        t.fail('late open');
      },
      stop: async () => {
        stops += 1;
      },
    }),
  );
  await stop;
  await commandOutcome;
  t.is(stops, 1);
  t.is(JSON.parse(f.getText()).phase, 'idle');
});

test('early cleanup failure is observed while open is pending; retry keeps the original owner', async t => {
  const opening = makePromiseKit();
  let stops = 0;
  const f = await fixture({
    provide: () =>
      Far('Pending', {
        open: () => opening.promise,
        stop: async () => {
          stops += 1;
          if (stops === 1) throw Error('cleanup pending');
        },
      }),
  });
  const commandOutcome = t.throwsAsync(
    E(f.owner.shell).exec('sh', harden([])),
    { message: /stopped/ },
  );
  await flush();
  const stopped = t.throwsAsync(E(f.owner.admin).stop(), {
    message: /cleanup pending/,
  });
  await flush();
  opening.resolve(f.nativeShell);
  await stopped;
  await commandOutcome;
  await E(f.owner.admin).stop();
  t.is(stops, 2);
  t.is(JSON.parse(f.getText()).phase, 'idle');
});

test('policy change stops before durable policy update; disposal does not resolve workspace', async t => {
  const f = await fixture();
  await E(f.owner.shell).exec('sh', harden([]));
  await E(f.owner.admin).setNetworkPolicy('public-internet');
  t.is(JSON.parse(f.getText()).networkPolicy, 'public-internet');
  await E(f.owner.admin).dispose();
  t.is(JSON.parse(f.getText()).phase, 'disposed');
  t.is(
    f.calls.filter(c => c[0] === 'resolve' && c[1] === 'workspace').length,
    1,
  );
  t.deepEqual(
    f.calls.filter(c => c[0] === 'remove'),
    [['remove', 'exact-id']],
  );
  await t.throwsAsync(E(f.owner.shell).exec('sh', harden([])), {
    message: /disposed/,
  });
});

test('recipe refuses open records and invalid execution bounds', t => {
  for (const invalid of [
    { ...recipe, unknown: true },
    { ...recipe, policy: { ...recipe.policy, env: {} } },
    { ...recipe, policy: { ...recipe.policy, allowedCommands: ['/bin/sh'] } },
    { ...recipe, policy: { ...recipe.policy, timeoutMs: 0 } },
  ])
    t.throws(() => assertEnvironmentRecipe(harden(invalid)));
});
