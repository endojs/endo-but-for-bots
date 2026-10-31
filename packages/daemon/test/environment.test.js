// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';
import { assertEnvironmentRecipe } from '@endo/exo-shell/environment-interfaces.js';
import { makeEnvironment } from '../src/environment.js';

test.beforeEach(t => t.timeout(5000));

const recipe = harden({
  policy: { allowedCommands: ['sh'], timeoutMs: 1000, maxOutputBytes: 4096 },
  networkPolicy: 'off',
});
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await null; // eslint-disable-line no-await-in-loop
};
/** @param {{ stored?: string, provide?: () => any, remove?: () => any, write?: (text: string, name: string) => any }} [options] */
const fixture = async ({ stored, provide, remove, write } = {}) => {
  let text = stored;
  const otherTexts = new Map();
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
    writeText: async (name, value) => {
      if (write) await write(value, name);
      if (name === 'lifecycle') text = value;
      else otherTexts.set(name, value);
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
    getNamedText: name => otherTexts.get(name),
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

test('failed execution retires its native owner before a later command; no effect is replayed', async t => {
  t.timeout(5000);
  let owners = 0;
  let effects = 0;
  let stops = 0;
  const stopped = makePromiseKit();
  const stopEntered = makePromiseKit();
  const f = await fixture({
    provide: () => {
      owners += 1;
      const first = owners === 1;
      return Far('RecoverableController', {
        open: () =>
          Far('NativeShell', {
            exec: async () => {
              effects += 1;
              if (first) throw Error('Shell command timed out; slice disposed');
              return harden({
                stdout: 'fresh',
                stderr: '',
                exitCode: 0,
                signal: null,
                truncated: false,
              });
            },
          }),
        stop: async () => {
          stops += 1;
          stopEntered.resolve(undefined);
          await stopped.promise;
        },
      });
    },
  });
  const failed = t.throwsAsync(E(f.owner.shell).exec('sh', harden([])), {
    message: /timed out/,
  });
  await stopEntered.promise;
  t.is(owners, 1);
  t.is(effects, 1);
  await t.throwsAsync(E(f.owner.shell).exec('sh', harden([])), {
    message: /stopped/,
  });
  t.is(owners, 1, 'no successor before native cleanup acknowledgement');
  stopped.resolve(undefined);
  await failed;
  t.is((await E(f.owner.admin).inspect()).phase, 'idle');
  const result = await E(f.owner.shell).exec('sh', harden([]));
  t.is(result.stdout, 'fresh');
  t.is(owners, 2);
  t.is(effects, 2, 'failed command was never automatically replayed');
  t.is(stops, 1);
  t.is(f.calls.filter(call => call[0] === 'remove').length, 0);
  await f.owner.shutdown();
});

test('failed execution retains its exact owner when cleanup fails', async t => {
  t.timeout(5000);
  let owners = 0;
  let stops = 0;
  let refuse = true;
  const f = await fixture({
    provide: () => {
      owners += 1;
      return Far('FailedController', {
        open: () =>
          Far('FailedShell', {
            exec: () => {
              throw Error('sandbox handle has been disposed');
            },
          }),
        stop: () => {
          stops += 1;
          if (refuse) throw Error('containment pending');
        },
      });
    },
  });
  await t.throwsAsync(E(f.owner.shell).exec('sh', harden([])), {
    message: /native cleanup remains pending/,
  });
  await t.throwsAsync(E(f.owner.shell).exec('sh', harden([])), {
    message: /stopped/,
  });
  t.is(owners, 1);
  t.is(stops, 1);
  refuse = false;
  await E(f.owner.admin).stop();
  t.is(stops, 2, 'operator retries the original retained cleanup owner');
  t.is((await E(f.owner.admin).inspect()).phase, 'idle');
  await f.owner.shutdown();
});

test('ordinary nonzero command status retains the usable native owner', async t => {
  t.timeout(5000);
  let owners = 0;
  let stops = 0;
  const f = await fixture({
    provide: () => {
      owners += 1;
      return Far('Controller', {
        open: () =>
          Far('Shell', {
            exec: () =>
              harden({
                stdout: '',
                stderr: 'test failed',
                exitCode: 37,
                signal: null,
                truncated: false,
              }),
          }),
        stop: () => {
          stops += 1;
        },
      });
    },
  });
  for (let i = 0; i < 2; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    t.is((await E(f.owner.shell).exec('sh', harden([]))).exitCode, 37);
  }
  t.is(owners, 1);
  t.is(stops, 0);
  await f.owner.shutdown();
});

test('operator records external cleanup before reopening a cold interrupted environment', async t => {
  const written = [];
  const f = await fixture({
    stored: JSON.stringify({ phase: 'active', networkPolicy: 'off' }),
    write: (_text, name) => written.push(name),
  });
  await t.throwsAsync(E(f.owner.shell).exec('sh', harden([])), {
    message: /operator cleanup/,
  });
  const note =
    'Old service admission excluded; original cgroup drained and recorded native resources reclaimed.';
  await E(f.owner.admin).acknowledgeExternalCleanup(note);
  t.deepEqual(written, ['external-cleanup', 'lifecycle']);
  t.deepEqual(JSON.parse(f.getNamedText('external-cleanup')), {
    environment: 'exact-id',
    note,
  });
  t.deepEqual(
    f.calls,
    [],
    'acknowledgement never revives a runner to infer cleanup',
  );
  t.false((await E(f.owner.admin).inspect()).interrupted);
  await E(f.owner.shell).exec('sh', harden([]));
  t.is(f.calls.filter(call => call[0] === 'provide').length, 1);
  t.is(f.calls.filter(call => call[0] === 'remove').length, 0);
  await f.owner.shutdown();
});

test('external cleanup cannot bypass a live owner, idle state, or a failed in-process intent', async t => {
  const f = await fixture();
  await t.throwsAsync(
    E(f.owner.admin).acknowledgeExternalCleanup('operator evidence'),
    {
      message: /interrupted restored environment/,
    },
  );
  await E(f.owner.shell).exec('sh', harden([]));
  await t.throwsAsync(
    E(f.owner.admin).acknowledgeExternalCleanup('operator evidence'),
    {
      message: /interrupted restored environment/,
    },
  );
  await E(f.owner.shell).exec('sh', harden([]));
  t.is(f.calls.filter(call => call[0] === 'stop').length, 0);
  await f.owner.shutdown();
  const failed = await fixture({
    write: () => {
      throw Error('lost intent ACK');
    },
  });
  await t.throwsAsync(E(failed.owner.shell).exec('sh', harden([])), {
    message: /lost intent ACK/,
  });
  await t.throwsAsync(
    E(failed.owner.admin).acknowledgeExternalCleanup('operator evidence'),
    {
      message: /interrupted restored environment/,
    },
  );
  t.deepEqual(failed.calls, []);
});

test('external cleanup publication failure preserves the fence and permits explicit retry', async t => {
  let refuse = true;
  const f = await fixture({
    stored: JSON.stringify({ phase: 'active', networkPolicy: 'off' }),
    write: (_text, name) => {
      if (refuse && name === 'external-cleanup')
        throw Error('cleanup note ACK lost');
    },
  });
  await t.throwsAsync(E(f.owner.admin).acknowledgeExternalCleanup(' '), {
    message: /nonempty note/,
  });
  await t.throwsAsync(
    E(f.owner.admin).acknowledgeExternalCleanup('operator evidence'),
    { message: /note ACK lost/ },
  );
  await t.throwsAsync(E(f.owner.shell).exec('sh', harden([])), {
    message: /stopped/,
  });
  t.is(JSON.parse(f.getText()).phase, 'active');
  t.deepEqual(f.calls, []);
  refuse = false;
  await E(f.owner.admin).acknowledgeExternalCleanup('operator evidence');
  await E(f.owner.shell).exec('sh', harden([]));
  await f.owner.shutdown();
});
