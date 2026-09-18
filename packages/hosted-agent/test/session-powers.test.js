// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makeSessionPowers } from '../src/session-powers.js';

const resource = Far('SelectedResource', { help: () => 'selected' });

test('session powers expose selected resources and enforce exact mount pairs', async t => {
  const calls = [];
  const mounts = [{ mountPoint: '/mount/work', mountName: 'work' }];
  const powers = makeSessionPowers({
    agent: Far('Host', {
      async provideMount(path, name, options) {
        calls.push({ path, name, options });
        return resource;
      },
      async remove(name) {
        calls.push({ removed: name });
      },
      lookup() {
        throw Error('host lookup must never be forwarded');
      },
    }),
    sandboxFactory: resource,
    fsMounter: resource,
    filesystem: resource,
    mounts,
  });
  mounts[0].mountName = 'unrelated';
  t.is(await E(powers).sandboxFactory(), resource);
  t.is(await E(powers).fsMounter(), resource);
  t.is(await E(powers).filesystem(), resource);
  t.is(await E(powers).configFilesystem(), null);
  t.is(await E(powers).mcpMount(), null);
  t.is(await E(powers).credentials(), null);
  t.is(await E(powers).stateProvider(), null);
  await t.throwsAsync(
    () => E(powers).provideMount('/mount/work', 'unrelated'),
    {
      message: /restricted/,
    },
  );
  await t.throwsAsync(() => E(powers).provideMount('/elsewhere', 'work'), {
    message: /restricted/,
  });
  await t.throwsAsync(() =>
    E(powers).provideMount(
      '/mount/work',
      'work',
      // Simulate an untyped caller crossing the Exo guard.
      /** @type {{ readOnly?: boolean }} */ (
        /** @type {unknown} */ (harden({ deniedSegments: [] }))
      ),
    ),
  );
  t.deepEqual(calls, [], 'unapproved mount options never reach the host');
  await E(powers).provideMount(
    '/mount/work',
    'work',
    harden({ readOnly: true }),
  );
  await E(powers).removeMount();
  t.deepEqual(calls, [
    { path: '/mount/work', name: 'work', options: { readOnly: true } },
    { removed: 'work' },
  ]);
});

test('state access cannot name another session', async t => {
  const calls = [];
  const powers = makeSessionPowers({
    agent: Far('Host', {
      async provideMount() {
        return resource;
      },
      async remove() {
        await null;
      },
    }),
    sandboxFactory: resource,
    fsMounter: resource,
    filesystem: resource,
    stateProvider: Far('StateProvider', {
      async provideSessionMount(id) {
        calls.push(['provide', id]);
        return resource;
      },
      async removeSession(id) {
        calls.push(['remove', id]);
      },
    }),
    sessionId: 'session-a',
    mounts: [],
  });
  const state = await E(powers).stateProvider();
  if (state === null) throw Error('Expected a scoped state provider');
  await E(state).provideSessionMount();
  await E(state).removeSession('session-a');
  await t.throwsAsync(() => E(state).provideSessionMount('session-b'), {
    message: /restricted/,
  });
  await t.throwsAsync(() => E(state).removeSession('session-b'), {
    message: /restricted/,
  });
  t.deepEqual(calls, [
    ['provide', 'session-a'],
    ['remove', 'session-a'],
  ]);
});

test('mount cleanup reports failures and still attempts independent names', async t => {
  const removed = [];
  const powers = makeSessionPowers({
    agent: Far('Host', {
      async provideMount() {
        return resource;
      },
      async remove(name) {
        removed.push(name);
        if (name === 'work') throw Error('removal failed');
      },
    }),
    sandboxFactory: resource,
    fsMounter: resource,
    filesystem: resource,
    mounts: [
      { mountPoint: '/mount/work', mountName: 'work' },
      { mountPoint: '/mount/config', mountName: 'config' },
    ],
  });
  const outcomes = await E(powers).removeMount();
  t.deepEqual(removed, ['work', 'config']);
  t.deepEqual(
    outcomes.map(result => result.status),
    ['rejected', 'fulfilled'],
  );
});
