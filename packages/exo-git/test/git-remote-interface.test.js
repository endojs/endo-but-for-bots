// @ts-check
/// <reference types="ses"/>

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';

import { GitRemoteInterface } from '../src/interfaces.js';

/** @import { GitRef, GitRemoteOperationResult, GitRemotePullResult } from '../src/types.js' */

const ref = /** @type {GitRef} */ (
  harden({ name: 'refs/heads/main', kind: 'branch', oid: 'a'.repeat(40) })
);
const update = harden({
  local: ref,
  remote: 'refs/heads/main',
  result: 'updated',
});
const operation = /** @type {GitRemoteOperationResult} */ (
  harden({ updatedRefs: [update], text: 'ok' })
);
const pull = /** @type {GitRemotePullResult} */ (
  harden({ fetch: operation, integration: 'fast-forward', head: ref })
);

const GIT_REMOTE_REF_UPDATE_RESULTS = harden([
  'created',
  'updated',
  'up-to-date',
  'fast-forward',
  'forced',
  'pruned',
  'rejected',
]);

/** @param {{ fetch?: unknown, pullResult?: unknown, push?: unknown }} options */
const makeRemote = ({
  fetch = operation,
  pullResult = pull,
  push = operation,
} = {}) =>
  /** @type {any} */ (
    makeExo(
      'GitRemote',
      GitRemoteInterface,
      /** @type {any} */ ({
        inspect: async () => harden({}),
        fetch: async () => fetch,
        pull: async () => pullResult,
        push: async () => push,
      }),
    )
  );

test('GitRemote result guards accept the concrete operation records', async t => {
  const remote = makeRemote({});
  t.deepEqual(await E(remote).fetch(), operation);
  t.deepEqual(await E(remote).pull(), pull);
  t.deepEqual(await E(remote).push(), operation);
});

test('GitRemote result guards reject malformed operation records', async t => {
  const remote = makeRemote({
    fetch: harden({
      updatedRefs: [{ remote: 'refs/heads/main' }],
      text: 'bad',
    }),
  });
  await t.throwsAsync(E(remote).fetch(), { message: /result/ });
});

test('GitRemote result guards accept every GitRemoteRefUpdateResult enum literal', async t => {
  for (const result of GIT_REMOTE_REF_UPDATE_RESULTS) {
    const withResult = harden({
      updatedRefs: [harden({ local: ref, remote: 'refs/heads/main', result })],
      text: 'ok',
    });
    const remote = makeRemote({ fetch: withResult });
    // eslint-disable-next-line no-await-in-loop
    t.deepEqual(await E(remote).fetch(), withResult, result);
  }
});

test('GitRemote result guards accept a ref update without the optional local field', async t => {
  const withoutLocal = harden({
    updatedRefs: [harden({ remote: 'refs/heads/main', result: 'pruned' })],
    text: 'ok',
  });
  const remote = makeRemote({ fetch: withoutLocal });
  t.deepEqual(await E(remote).fetch(), withoutLocal);
});

test('GitRemote result guards reject an out-of-enum ref update result', async t => {
  const remote = makeRemote({
    fetch: harden({
      updatedRefs: [harden({ remote: 'refs/heads/main', result: 'bogus' })],
      text: 'bad',
    }),
  });
  await t.throwsAsync(E(remote).fetch(), { message: /result/ });
});

test('GitRemote result guards reject a malformed pull record', async t => {
  const remote = makeRemote({
    pullResult: harden({
      fetch: operation,
      integration: 'bogus',
      head: ref,
    }),
  });
  await t.throwsAsync(E(remote).pull(), { message: /result/ });
});

test('GitRemote result guards reject a pull record missing head', async t => {
  const remote = makeRemote({
    pullResult: harden({
      fetch: operation,
      integration: 'fast-forward',
    }),
  });
  await t.throwsAsync(E(remote).pull(), { message: /result/ });
});

test('GitRemote result guards reject malformed push records', async t => {
  const remote = makeRemote({
    push: harden({
      updatedRefs: [{ remote: 'refs/heads/main' }],
      text: 'bad',
    }),
  });
  await t.throwsAsync(E(remote).push(), { message: /result/ });
});
