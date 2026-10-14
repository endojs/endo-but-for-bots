// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { makePromiseKit } from './_promise-kit.js';

import { provisionFlootFactory } from '../src/provision-factory.js';

const current = 'file:///var/lib/endo/current/packages/floot/agent.js';
const prior = 'file:///var/lib/endo/releases/old/packages/floot/agent.js';
const options = harden({
  controllerPath: ['floot', 'controller'],
  pinPath: ['@pins', 'floot-controller'],
  powersName: ['floot', 'controller-profile'],
  specifier: current,
  env: {},
});

/** @param {{ specifier?: string, constructionEnv?: Record<string, string>, cancel?: () => Promise<void> }} [config] */
const makeHost = ({
  specifier = current,
  constructionEnv = {},
  cancel = async () => {},
} = {}) => {
  const names = new Map([
    ['floot/controller-profile', 'powers'],
    ['floot/controller', 'factory'],
    ['@pins/floot-controller', 'factory'],
  ]);
  const calls = [];
  const agent = Far('Host', {
    identify: (...path) => names.get(path.join('/')),
    getFormula: () =>
      harden({
        type: 'make-unconfined',
        properties: {
          powers: { identifier: 'powers' },
          specifier: { value: specifier },
        },
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
      names.set(to.join('/'), names.get(from.join('/')));
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
