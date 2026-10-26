// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import {
  createProviderBackedAgent,
  issueProviderBackedFactory,
} from '../examples/provider-backed-agent.js';

test('provider-backed issuance hands the owner only a bound facet', async t => {
  const makeFake = (name, methods = {}) =>
    makeExo(
      name,
      M.interface(name, {}, { defaultGuards: 'passable' }),
      methods,
    );
  const providerUse = makeFake('InferenceProviderUse');
  const maker = makeFake('AgentDriverMaker');
  const handle = makeFake('ChildHandle');
  /** @type {Array<{ value: any, name: string }>} */
  const ownerNames = [];
  /** @type {any[]} */
  const makerCalls = [];
  /** @type {any[]} */
  const bindCalls = [];
  /** @type {any[]} */
  const createCalls = [];

  const boundFactory = makeFake('BoundChildAgentFactory', {
    create(name, options) {
      createCalls.push({ name, options });
      return harden({
        summary: harden({
          name,
          phase: 'Committed',
          createdAt: 1,
          operationId: 'provider-example',
        }),
        handle,
      });
    },
  });
  const root = makeFake('ChildAgentFactory', {
    bind(receivedMaker, policy) {
      bindCalls.push({ maker: receivedMaker, policy });
      return boundFactory;
    },
  });
  const deploymentHost = makeFake('DeploymentHost', {
    lookup(path) {
      t.deepEqual(path, ['agent-factory', 'root']);
      return root;
    },
  });
  const driverMakerFactory = makeFake('DriverMakerFactory', {
    makeDriverMaker(receivedProviderUse, configuration) {
      makerCalls.push({ providerUse: receivedProviderUse, configuration });
      return maker;
    },
  });
  const ownerGuest = makeFake('OwnerGuest', {
    storeValue(value, name) {
      ownerNames.push({ value, name });
    },
  });

  const policy = harden({
    maxChildren: 2,
    maxInstructionBytes: 1024,
    endowmentNames: harden(['notes']),
  });
  const ownerFactory = await issueProviderBackedFactory({
    deploymentHost,
    ownerGuest,
    providerUse,
    driverMakerFactory,
    harness: 'lal',
    model: 'provider-model',
    limits: harden({ dailyDollars: 2 }),
    policy,
  });
  const summary = await createProviderBackedAgent({
    boundFactory: ownerFactory,
    ownerGuest,
    name: 'helper',
    instructions: 'Summarize new notes.',
    endowments: { notes: makeFake('Notes') },
  });

  t.is(ownerFactory, boundFactory);
  t.deepEqual(makerCalls, [
    {
      providerUse,
      configuration: {
        harness: 'lal',
        model: 'provider-model',
        limits: { dailyDollars: 2 },
      },
    },
  ]);
  t.deepEqual(bindCalls, [{ maker, policy }]);
  t.is(createCalls.length, 1);
  t.like(summary, { name: 'helper', phase: 'Committed' });
  t.deepEqual(ownerNames, [
    { value: boundFactory, name: 'child-agents' },
    { value: handle, name: 'helper' },
  ]);
  t.false(ownerNames.some(({ value }) => value === providerUse));
  t.false(ownerNames.some(({ value }) => value === maker));
  t.false(ownerNames.some(({ value }) => value === root));
});
