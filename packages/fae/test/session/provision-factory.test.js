// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { makePromiseKit } from './_promise-kit.js';

import { provisionFlootFactory } from '../../session/provision-factory.js';

const current = 'file:///var/lib/endo/current/packages/floot/agent.js';
const prior = 'file:///var/lib/endo/releases/old/packages/floot/agent.js';
const options = harden({
  controllerPath: ['floot', 'controller'],
  pinPath: ['@pins', 'floot-controller'],
  powersName: ['floot', 'controller-profile'],
  specifier: current,
  env: {},
});

/** @param {{ specifier?: string, worker?: string, constructionEnv?: Record<string, string>, cancel?: () => Promise<void> }} [config] */
const makeHost = ({
  specifier = current,
  worker = 'trusted-worker',
  constructionEnv = {},
  cancel = async () => {},
} = {}) => {
  const names = new Map([
    ['@main', 'trusted-worker'],
    ['floot/controller-profile', 'powers'],
    ['floot/controller', 'factory'],
    ['@pins/floot-controller', 'factory'],
  ]);
  const calls = [];
  const agent = Far('Host', {
    identify: (...path) => names.get(path.join('/')),
    diagnostics: () =>
      Far('Diagnostics', {
        getFormula: () =>
          harden({
            type: 'make-unconfined',
            properties: {
              worker: { identifier: worker },
              powers: { identifier: 'powers' },
              specifier: { value: specifier },
            },
          }),
      }),
    getFormulaEnvironment: () => harden(constructionEnv),
    cancel: async path => {
      calls.push('cancel');
      await cancel();
      calls.push('drained');
    },
    remove: (...path) => {
      calls.push('remove');
      names.delete(path.join('/'));
    },
    makeUnconfined: (_worker, _specifier, { resultName }) => {
      calls.push('make');
      names.set(resultName.join('/'), 'replacement');
    },
    copy: (from, to) => {
      calls.push('copy');
      const value = names.get(from.join('/'));
      if (value === undefined) throw Error('Missing source binding');
      names.set(to.join('/'), value);
    },
  });
  return { agent, names, calls };
};

test('warm setup reuses the factory and restores its pin without a second writer', async t => {
  const { agent, names, calls } = makeHost();
  names.delete('@pins/floot-controller');
  t.deepEqual(await provisionFlootFactory({ agent, ...options }), {
    reused: true,
  });
  t.deepEqual(calls, ['copy']);
  t.is(names.get('@pins/floot-controller'), 'factory');
});

test('replacement waits for cancellation drain before removing or creating', async t => {
  t.timeout(10_000);
  const drain = makePromiseKit();
  const entered = makePromiseKit();
  const { agent, calls } = makeHost({
    specifier: prior,
    cancel: () => {
      entered.resolve();
      return drain.promise;
    },
  });
  const operation = provisionFlootFactory({ agent, ...options });
  await entered.promise;
  t.deepEqual(calls, ['cancel']);
  drain.resolve();
  t.deepEqual(await operation, { reused: false });
  t.deepEqual(calls, ['cancel', 'drained', 'remove', 'remove', 'make', 'copy']);
});

test('failed cancellation keeps the old names and refuses a second writer', async t => {
  const { agent, names, calls } = makeHost({
    specifier: prior,
    cancel: async () => {
      throw Error('cleanup pending');
    },
  });
  await t.throwsAsync(provisionFlootFactory({ agent, ...options }), {
    message: 'cleanup pending',
  });
  t.deepEqual(calls, ['cancel']);
  t.is(names.get('floot/controller'), 'factory');
  t.is(names.get('@pins/floot-controller'), 'factory');
});

test('changed construction policy drains the prior factory even at the same module path', async t => {
  const { agent, calls } = makeHost({
    constructionEnv: { FLOOT_MAX_SUBAGENTS: '8' },
  });
  t.deepEqual(
    await provisionFlootFactory({
      agent,
      ...options,
      env: { FLOOT_MAX_SUBAGENTS: '4' },
    }),
    { reused: false },
  );
  t.deepEqual(calls, ['cancel', 'drained', 'remove', 'remove', 'make', 'copy']);
});

test('a retained Fae controller is reused only for its own entry point', async t => {
  const specifier =
    'file:///var/lib/endo/current/packages/fae/session-factory.js';
  const { agent, calls } = makeHost({ specifier });
  t.true(
    (await provisionFlootFactory({ ...options, agent, specifier })).reused,
  );
  await t.throwsAsync(provisionFlootFactory({ ...options, agent }));
  t.false(calls.includes('cancel'));
});

test('retained or stale pinned controllers on another worker or arbitrary checkout are preserved', async t => {
  const foreign = 'file:///tmp/unrelated/packages/floot/agent.js';
  for (const config of [{ worker: 'other-worker' }, { specifier: foreign }]) {
    for (const onlyPin of [true, false]) {
      const { agent, names, calls } = makeHost(config);
      if (onlyPin) names.delete('floot/controller');
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(provisionFlootFactory({ agent, ...options }), {
        message: /preserve it for inspection/,
      });
      t.is(names.get('@pins/floot-controller'), 'factory');
      t.deepEqual(calls, []);
    }
  }
});

test('moving a known local checkout drains the exact former factory and preserves other entrypoints', async t => {
  const previousSpecifier = 'file:///local/old/packages/floot/agent.js';
  const specifier = 'file:///local/new/packages/floot/agent.js';
  const { agent, calls } = makeHost({ specifier: previousSpecifier });
  await t.throwsAsync(provisionFlootFactory({ agent, ...options, specifier }), {
    message: /preserve/,
  });
  t.deepEqual(calls, []);
  await t.throwsAsync(
    provisionFlootFactory({
      agent,
      ...options,
      specifier,
      previousSpecifier: 'file:///local/old/packages/fae/session-factory.js',
    }),
    { message: /prior session factory entry point/ },
  );
  t.deepEqual(calls, []);
  t.false(
    (
      await provisionFlootFactory({
        agent,
        ...options,
        specifier,
        previousSpecifier,
      })
    ).reused,
  );
  t.deepEqual(calls, ['cancel', 'drained', 'remove', 'remove', 'make', 'copy']);
});
