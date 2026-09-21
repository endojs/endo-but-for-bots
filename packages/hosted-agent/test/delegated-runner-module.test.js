// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { make as makeFacet } from '../src/delegated-runner-facet-module.js';
import { make } from '../src/delegated-runner-module.js';

const makeNamespace = (initial = {}) => {
  const names = new Map(Object.entries(initial));
  return {
    names,
    powers: Far('powers', {
      has: async name => names.has(name),
      list: async () => [...names.keys()],
      lookup: async name => names.get(name),
      storeValue: async (value, name) => {
        names.set(name, value);
      },
      remove: async name => {
        names.delete(name);
      },
    }),
  };
};

const makeBackend = label => {
  /** @type {any[]} */
  const created = [];
  return {
    created,
    factory: Far(label, {
      describe: async () =>
        harden({
          id: 'codex',
          title: 'Codex',
          kind: 'hosted',
          continuity: 'opaque',
          toolOwnership: 'endo',
        }),
      modelCatalog: async () => harden({ accounts: [] }),
      create: async spec => {
        created.push(spec);
        return harden({
          run: Far('run', { send: async () => 'a turn' }),
          admin: Far('admin', { terminate: async () => {} }),
        });
      },
      stop: async () => {},
      destroy: async () => {},
    }),
  };
};

const tools = Far('HostedToolSet', {});

test('the runner’s sessions and its revocation live in its own namespace, across a restart and a new backend', async t => {
  const first = makeBackend('backend 1');
  const space = makeNamespace({
    backend: first.factory,
    'runner-limits': harden({
      subscription: 'lane-alice',
      maxSessions: 1,
      storage: 'unbounded',
    }),
  });
  const kit = await make(space.powers, undefined, {
    env: { RUNNER_ID: 'alice' },
  });
  const runner = await makeFacet(kit);
  // What is handed out is a backend factory and nothing of the kit.
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(runner).__getMethodNames__();
  t.false(methods.includes('revoke'));
  t.false(methods.includes('runner'));
  await E(runner).create(harden({ sessionId: 's1' }), tools);
  t.is(first.created[0].sessionId, 'r-alice-s1');
  t.is(first.created[0].subscription, 'lane-alice');

  // The daemon restarts and a deploy has minted the backend again: setup
  // re-points the name, and the revived runner still counts its session.
  const second = makeBackend('backend 2');
  space.names.set('backend', second.factory);
  const revived = await make(space.powers, undefined, {
    env: { RUNNER_ID: 'alice' },
  });
  await t.throwsAsync(
    () => E(E(revived).runner()).create(harden({ sessionId: 's2' }), tools),
    { message: /no free session slot/ },
  );
  await E(E(revived).runner()).create(harden({ sessionId: 's1' }), tools);
  t.is(second.created.length, 1, 'through the backend that exists now');

  await E(revived).revoke();
  const again = await make(space.powers, undefined, {
    env: { RUNNER_ID: 'alice' },
  });
  t.true((await E(again).getStatus()).revoked);
  await t.throwsAsync(
    () => E(E(again).runner()).create(harden({ sessionId: 's1' }), tools),
    { message: /Runner revoked/ },
  );
});

test('a runner with no id fails plainly', async t => {
  await t.throwsAsync(() => make(makeNamespace().powers, undefined, {}), {
    message: /RUNNER_ID/,
  });
});
