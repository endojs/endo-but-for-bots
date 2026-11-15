// @ts-check

/**
 * Tests for the `PiAgent`-backed RPC session adapter.
 *
 * The agent is a plain fake that records what the adapter forwards to it;
 * the model queries run against pi-ai's real registry, so these fail if the
 * adapter stops forwarding a call, mis-shapes a steering message, or lets an
 * unknown model selection clear the agent's model.
 */

import test from '@endo/ses-ava/prepare-endo.js';

import { getModels } from '@earendil-works/pi-ai/compat';

import { makeRpcSession } from '../../src/rpc/session.js';

/** @param {unknown} [model] */
const makeFakePiAgent = model => {
  const calls = {
    /** @type {unknown[]} */ prompt: [],
    /** @type {Array<{ role: string, content: string, timestamp: number }>} */
    steer: [],
    abort: 0,
    unsubscribed: 0,
  };
  /** @type {((event: unknown) => void) | undefined} */
  let listener;
  const piAgent = {
    state: { model },
    /** @param {(event: unknown) => void} l */
    subscribe: l => {
      listener = l;
      return () => {
        calls.unsubscribed += 1;
      };
    },
    /** @param {unknown} message */
    prompt: async message => {
      calls.prompt.push(message);
    },
    abort: () => {
      calls.abort += 1;
    },
    /** @param {{ role: string, content: string, timestamp: number }} message */
    steer: message => {
      calls.steer.push(message);
    },
  };
  return {
    piAgent,
    calls,
    /** @param {unknown} event */
    emit: event => listener && listener(event),
  };
};

/** @param {ReturnType<typeof makeFakePiAgent>} fake */
const sessionOf = fake =>
  // @ts-expect-error - a structural fake stands in for the pi-agent-core Agent
  makeRpcSession({ piAgent: fake.piAgent });

test('forwards subscribe, prompt, and abort to the agent', async t => {
  const fake = makeFakePiAgent();
  const session = sessionOf(fake);
  /** @type {unknown[]} */
  const seen = [];
  const unsubscribe = session.subscribe(event => seen.push(event));
  fake.emit({ type: 'agent_start' });
  t.deepEqual(seen, [{ type: 'agent_start' }]);
  unsubscribe();
  t.is(fake.calls.unsubscribed, 1);

  await session.prompt('hello');
  t.deepEqual(fake.calls.prompt, ['hello']);
  session.abort();
  t.is(fake.calls.abort, 1);
});

test('steer — wraps the text as a timestamped user message', t => {
  const fake = makeFakePiAgent();
  const session = sessionOf(fake);
  const before = Date.now();
  session.steer('turn left');
  t.is(fake.calls.steer.length, 1);
  const [message] = fake.calls.steer;
  t.is(message.role, 'user');
  t.is(message.content, 'turn left');
  t.true(message.timestamp >= before && message.timestamp <= Date.now());
});

test('describeModel — prefers the name, then the id, then unknown', t => {
  t.is(
    sessionOf(makeFakePiAgent({ id: 'm-id', name: 'M Name' })).describeModel(),
    'M Name',
  );
  t.is(sessionOf(makeFakePiAgent({ id: 'm-id' })).describeModel(), 'm-id');
  t.is(sessionOf(makeFakePiAgent()).describeModel(), 'unknown');
});

test('listModels — enumerates the registry by provider', t => {
  const { providers, models } = sessionOf(makeFakePiAgent()).listModels();
  t.true(providers.includes('anthropic'));
  const anthropic = models.filter(m => m.provider === 'anthropic');
  t.deepEqual(
    anthropic.map(m => m.id),
    getModels('anthropic').map(m => m.id),
  );
  for (const model of models) {
    t.true(providers.includes(model.provider));
    t.is(typeof model.id, 'string');
  }
});

test('setModel — resolves a registry model onto the agent', async t => {
  const fake = makeFakePiAgent({ id: 'previous' });
  const [target] = getModels('anthropic');
  await sessionOf(fake).setModel({ provider: 'anthropic', model: target.id });
  t.is(/** @type {any} */ (fake.piAgent.state.model).id, target.id);
});

test('setModel — rejects an unknown model and keeps the current one', async t => {
  const previous = { id: 'previous' };
  const fake = makeFakePiAgent(previous);
  const session = sessionOf(fake);
  await t.throwsAsync(
    session.setModel({ provider: 'anthropic', model: 'no-such-model' }),
    { message: 'unknown model: anthropic/no-such-model' },
  );
  await t.throwsAsync(
    session.setModel({ provider: 'no-such-provider', model: 'x' }),
    { message: /unknown model/ },
  );
  t.is(fake.piAgent.state.model, previous);
});

test('the session guards its seam against off-shape arguments', async t => {
  const fake = makeFakePiAgent();
  const session = sessionOf(fake);
  await t.throwsAsync(
    // @ts-expect-error - deliberately off-shape
    session.prompt(42),
  );
  t.throws(
    // @ts-expect-error - deliberately off-shape
    () => session.steer({ role: 'system' }),
  );
  await t.throwsAsync(
    // @ts-expect-error - deliberately off-shape
    session.setModel({ provider: 'anthropic' }),
  );
  t.deepEqual(fake.calls.prompt, []);
  t.deepEqual(fake.calls.steer, []);
});
