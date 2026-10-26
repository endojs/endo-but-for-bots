// @ts-check
// prefer-endo-primitives-exempt: Far instances are explicit remotable test doubles.

import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeExo } from '@endo/exo';
import {
  CredentialSourceInterface,
  InferenceBackendInterface,
} from '@endo/inference/guards.js';

import {
  makeChildAgentSpawner,
  makeInferenceAgentDriverMaker,
  prepareChildAgentCoordinator,
} from '../index.js';
import { makeFakeDaemon } from './_fake-host.js';

const neverCancelled = new Promise(() => {});

test('inference adapter derives the child projection for every turn and hides credentials', async t => {
  const releases = [];
  let acquisitions = 0;
  const credentialSource = makeExo(
    'CredentialSource',
    CredentialSourceInterface,
    {
      async acquire() {
        await null;
        acquisitions += 1;
        return harden({
          type: 'granted',
          env: harden({ ANTHROPIC_API_KEY: 'secret' }),
          release: Far('release', () => {
            releases.push(acquisitions);
          }),
        });
      },
    },
  );
  const requests = [];
  const backend = makeExo('CredentialedBackend', InferenceBackendInterface, {
    describe: () => harden({ provider: 'test', kind: 'fake' }),
    async infer(request) {
      const grant = await E(credentialSource).acquire();
      requests.push(request);
      if (grant.type === 'granted') await E(grant.release)();
      return harden({ type: 'ok', text: 'done' });
    },
  });
  const agent = Far('Agent', {});
  const stored = new Map();
  const driverGuest = Far('DriverGuest', {
    storeValue: (value, name) => stored.set(name, value),
  });
  let projections = 0;
  const maker = makeInferenceAgentDriverMaker({
    backend,
    driverSpecifier: 'file:///driver.js',
    makeGuestToolProjection: received => {
      t.is(received, agent);
      projections += 1;
      return harden({
        buildMcpServer: Far('buildMcpServer', () => harden({})),
        toolNames: harden([`tool-${projections}`]),
        formulaIdentifier: `child-${projections}`,
      });
    },
  });
  const descriptor = await E(maker).installDriver(
    harden({
      agent,
      driverGuest,
      lifecycle: Far('Lifecycle', {}),
    }),
  );
  t.deepEqual(descriptor, { specifier: 'file:///driver.js' });
  t.deepEqual([...stored.keys()].sort(), ['agent', 'inference']);
  t.false([...stored.values()].includes(credentialSource));

  const request = harden({
    prompt: 'hello',
    limits: harden({
      maxWallClockMs: 1000,
      maxOutputBytes: 4096,
      maxTurns: 3,
    }),
    cancelled: neverCancelled,
  });
  await E(stored.get('inference')).infer(request);
  await E(stored.get('inference')).infer(request);
  t.is(acquisitions, 2);
  t.deepEqual(releases, [1, 2]);
  t.deepEqual(
    requests.map(({ guest }) => guest.formulaIdentifier),
    ['child-1', 'child-2'],
  );
  t.deepEqual(requests[0].guest.toolNames, ['tool-1']);
  t.deepEqual(requests[1].guest.toolNames, ['tool-2']);
});

test('child spawner attaches explicit powers and recursively revokes descendants', async t => {
  const daemon = makeFakeDaemon();
  const coordinator = await prepareChildAgentCoordinator({
    host: daemon.host,
    rootPolicy: {
      maxChildren: 4,
      maxInstructionBytes: 100,
      endowmentNames: ['notes', 'subagent-spawner'],
    },
  });
  const { maker } = daemon.makeMaker();
  const bound = await E(coordinator.rootFacet).bind(maker);
  const spawner = makeChildAgentSpawner({
    factory: bound,
    spawnerEndowmentName: 'subagent-spawner',
  });
  const notes = Far('Notes', {});
  const { handle } = await E(spawner).spawn('helper', {
    instructions: 'Summarize.',
    endowments: { notes },
  });
  t.truthy(handle);
  t.deepEqual(await E(spawner).list(), ['helper']);

  const guestName = [...daemon.names.keys()].find(name =>
    name.endsWith('.guest'),
  );
  t.truthy(guestName);
  const guestEntries = await E(daemon.host).list(
    /** @type {string} */ (guestName),
  );
  t.deepEqual(guestEntries, ['@self', 'notes', 'subagent-spawner']);
  t.is(
    await E(daemon.host).lookup(/** @type {string} */ (guestName), 'notes'),
    notes,
  );
  const nested = await E(daemon.host).lookup(
    /** @type {string} */ (guestName),
    'subagent-spawner',
  );
  await E(nested).spawn('grandchild');
  t.is(
    [...daemon.names.keys()].filter(name => name.endsWith('.guest')).length,
    2,
  );

  await E(spawner).stop('helper');
  t.deepEqual(await E(spawner).list(), []);
  t.deepEqual(
    [...daemon.names.keys()].filter(name => name.endsWith('.guest')),
    [],
  );
});
