// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { M } from '@endo/patterns';
import { makeWorkflowService } from '../src/service.js';
import { makeFakeAgent, makeFakeClock } from './fake-agent.js';

const makeIdCounter = (prefix = 'id') => {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}${n}`;
  };
};

const until = async (fn, label = 'condition', tries = 400) => {
  await null;
  for (let i = 0; i < tries; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn()) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  throw Error(`timed out waiting for ${label}`);
};

const jobChart = harden({
  name: 'job',
  version: 1,
  params: M.splitRecord({ repo: M.string(), branch: M.string() }),
  initial: 'work',
  states: {
    work: {
      entry: [
        {
          kind: 'invoke',
          target: 'runner',
          method: 'perform',
          args: [{ $params: 'repo' }, { $params: 'branch' }],
          outcome: 'done-work',
        },
      ],
      on: {
        'done-work': [{ target: 'ok', assign: { got: { $event: 'value' } } }],
      },
    },
    ok: { final: true, output: { got: { $ctx: 'got' } } },
  },
});

const makeRunner = () => {
  /** @type {any[]} */
  const calls = [];
  const runner = Far('Runner', {
    perform: async (repo, branch, _effectId) => {
      calls.push([repo, branch]);
      return `ran ${repo}#${branch}`;
    },
  });
  return { runner, calls };
};

test('a factory binds chart, params, and endowments; start returns an observer', async t => {
  const { powers } = makeFakeAgent();
  const { service, stop, engines } = await makeWorkflowService({
    powers,
    clock: makeFakeClock(),
    makeId: makeIdCounter(),
  });
  t.teardown(stop);
  const { runner, calls } = makeRunner();
  const { fid, factory } = await E(service).makeFactory({
    chart: jobChart,
    params: harden({ repo: 'endo' }),
    endowments: harden({ runner }),
  });
  t.regex(fid, /^f-/);
  const described = await E(factory).describe();
  t.like(described, {
    fid,
    chartName: 'job',
    chartVersion: 1,
    revoked: false,
  });
  t.deepEqual(described.boundParamNames, ['repo']);
  t.deepEqual(described.endowmentNames, ['runner']);

  // The starter fills only the open slots and gets observation only.
  const { runId, run } = await E(factory).start({
    params: harden({ branch: 'main' }),
  });
  const engine = engines.get(runId);
  await until(() => engine.fold.done, 'run completion');
  t.deepEqual(calls, [['endo', 'main']]);
  t.deepEqual(engine.fold.output, { got: 'ran endo#main' });
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(run).__getMethodNames__();
  t.false(methods.includes('signal'));
  t.false(methods.includes('cancel'));
  const status = await E(run).status();
  t.is(status.factory, fid);
  // The journal attributes the run to the factory durably.
  const journal = await E(run).journal();
  t.is(journal[0].factory, fid);

  // Bound names cannot be overridden by the starter.
  await t.throwsAsync(
    () => E(factory).start({ params: harden({ repo: 'evil' }) }),
    { message: /already binds param/ },
  );
  await t.throwsAsync(
    () =>
      E(factory).start({
        params: harden({ branch: 'x' }),
        endowments: harden({ runner: Far('Fake', {}) }),
      }),
    { message: /already binds endowment/ },
  );
  // Factory-bound params must be data; capabilities ride endowments.
  await t.throwsAsync(
    () =>
      E(service).makeFactory({
        chart: jobChart,
        params: harden({ repo: Far('Sneaky', {}) }),
      }),
    { message: /capability-free/ },
  );
});

test('with() derives a narrower factory; revoke() cascades to descendants and their runs', async t => {
  const { powers, controls } = makeFakeAgent();
  const { service, stop, engines } = await makeWorkflowService({
    powers,
    clock: makeFakeClock(),
    makeId: makeIdCounter(),
  });
  t.teardown(stop);
  const askChart = harden({
    name: 'gated',
    version: 1,
    params: M.splitRecord({ repo: M.string(), branch: M.string() }),
    initial: 'asking',
    states: {
      asking: {
        entry: [
          {
            kind: 'ask',
            to: 'operator',
            what: { description: 'Approve {$params.repo}?' },
            outcome: 'answered',
          },
        ],
        on: { answered: [{ target: 'ok' }] },
      },
      ok: { final: true },
    },
  });
  const { fid, factory } = await E(service).makeFactory({
    chart: askChart,
    endowments: harden({ operator: harden({}) }),
  });
  const derived = await E(factory).with({
    params: harden({ repo: 'endo' }),
  });
  const derivedDescription = await E(derived).describe();
  t.is(derivedDescription.parent, fid);
  t.deepEqual(derivedDescription.boundParamNames, ['repo']);

  const { runId } = await E(derived).start({
    params: harden({ branch: 'main' }),
  });
  const engine = engines.get(runId);
  await until(() => engine.fold.pending.size === 1, 'ask pending');

  await E(factory).revoke('rotation');
  t.true((await E(factory).describe()).revoked);
  t.true((await E(derived).describe()).revoked);
  await t.throwsAsync(() => E(derived).start({}), { message: /revoked/ });
  await until(() => engine.fold.done, 'run cancelled');
  t.is(engine.fold.outcome, 'cancelled');
  t.regex(engine.fold.reason, /revoked: rotation/);
  t.truthy(controls);
});

test('factories persist across restarts, revocation included', async t => {
  const { powers, controls } = makeFakeAgent();
  const h1 = await makeWorkflowService({
    powers,
    clock: makeFakeClock(),
    makeId: makeIdCounter('a'),
  });
  const { runner, calls } = makeRunner();
  const { fid } = await E(h1.service).makeFactory({
    chart: jobChart,
    params: harden({ repo: 'endo' }),
    endowments: harden({ runner }),
  });
  h1.stop();

  const h2 = await makeWorkflowService({
    powers: controls.restart(),
    clock: makeFakeClock(),
    makeId: makeIdCounter('b'),
  });
  const factory = await E(h2.service).factory(fid);
  const { runId } = await E(factory).start({
    params: harden({ branch: 'dev' }),
  });
  const engine = h2.engines.get(runId);
  await until(() => engine.fold.done, 'run completion');
  t.deepEqual(calls, [['endo', 'dev']]);
  await E(factory).revoke();
  h2.stop();

  const h3 = await makeWorkflowService({
    powers: controls.restart(),
    clock: makeFakeClock(),
    makeId: makeIdCounter('c'),
  });
  t.teardown(h3.stop);
  const revived = await E(h3.service).factory(fid);
  t.true((await E(revived).describe()).revoked);
  await t.throwsAsync(() => E(revived).start({}), { message: /revoked/ });
  await t.throwsAsync(() => E(h3.service).factory('f-none'), {
    message: /no workflow factory/,
  });
});
