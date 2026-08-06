// @ts-check
/// <reference types="ses"/>

/**
 * @import { GitBackend } from '../src/git.js'
 * @import { RemotePolicy } from '../src/types.js'
 */

import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';

import {
  makeGit,
  makeGitOperations,
  makeGitRemote,
  makeNotYetImplementedBackend,
  normalizeGitRemotePolicy,
} from '../src/index.js';

const FETCH_REFSPECS = harden([
  '+refs/heads/zeta:refs/remotes/origin/zeta',
  '+refs/heads/alpha:refs/remotes/origin/alpha',
]);

/** @returns {RemotePolicy} */
const makePolicy = () => ({
  url: 'file:///remote.git',
  allowedDirections: ['fetch'],
  fetchRefspecs: [...FETCH_REFSPECS],
  pushRefspecs: [],
  allowLocalFileTransport: true,
});

/**
 * @param {RemotePolicy} policy
 */
const makeRemoteHarness = policy => {
  /** @type {string[]} */
  const mergedRefs = [];
  /** @type {string[][]} */
  const fetchedRefspecLists = [];
  /** @type {GitBackend} */
  const backend = harden({
    ...makeNotYetImplementedBackend(),
    remoteFetch: async ({ refspecs }) => {
      fetchedRefspecLists.push([.../** @type {string[]} */ (refspecs)]);
      return harden({ updatedRefs: harden([]), text: '' });
    },
    revParse: async ref =>
      harden({
        name: ref,
        kind: 'commit',
        oid: '0'.repeat(40),
      }),
    merge: async ref => {
      mergedRefs.push(ref);
      return 'merged';
    },
  });
  const mount = makeExo('FakeGitRemotePolicyMount', undefined, {});
  const git = makeGit(
    /** @type {Parameters<typeof makeGit>[0]} */ (
      /** @type {unknown} */ ({
        mount,
        backend,
        lineageOf: () => undefined,
      })
    ),
  );
  const operations = makeGitOperations({ backend, git });
  const { remote } = makeGitRemote({
    git,
    operations,
    name: 'origin',
    policy,
  });
  return { fetchedRefspecLists, mergedRefs, remote };
};

test('normalization preserves reverse-lexicographic refspec order', t => {
  const policy = makePolicy();
  policy.allowedDirections = ['fetch', 'fetch'];
  policy.pushRefspecs = [
    'refs/heads/zeta:refs/heads/zeta',
    'refs/heads/alpha:refs/heads/alpha',
  ];
  const normalized = normalizeGitRemotePolicy({ name: 'origin', policy });

  t.deepEqual([...normalized.allowedDirections], ['fetch']);
  t.deepEqual([...normalized.fetchRefspecs], [...FETCH_REFSPECS]);
  t.deepEqual(
    [...normalized.pushRefspecs],
    ['refs/heads/zeta:refs/heads/zeta', 'refs/heads/alpha:refs/heads/alpha'],
  );
});

test('normalization retains allowedBranches in policy snapshots', t => {
  const normalized = normalizeGitRemotePolicy({
    name: 'origin',
    policy: {
      ...makePolicy(),
      allowedDirections: ['push'],
      allowedBranches: ['main', 'refs/heads/release/*'],
    },
  });

  t.deepEqual(normalized.allowedBranches, ['main', 'refs/heads/release/*']);
  t.deepEqual(
    [...normalized.pushRefspecs],
    [
      'refs/heads/main:refs/heads/main',
      'refs/heads/release/*:refs/heads/release/*',
    ],
  );
});

test('explicit defaultPullRef controls unqualified pull', async t => {
  const policy = {
    ...makePolicy(),
    defaultPullRef: 'refs/heads/alpha',
  };
  const normalized = normalizeGitRemotePolicy({ name: 'origin', policy });
  const { fetchedRefspecLists, mergedRefs, remote } = makeRemoteHarness(policy);

  const snapshot = await E(remote).inspect();
  t.deepEqual(snapshot, harden({ name: 'origin', ...normalized }));
  await E(remote).pull();

  t.deepEqual(fetchedRefspecLists, [[...FETCH_REFSPECS]]);
  t.deepEqual(mergedRefs, ['refs/remotes/origin/alpha']);
});

test('omitted defaultPullRef preserves first-concrete-refspec pull', async t => {
  const { fetchedRefspecLists, mergedRefs, remote } =
    makeRemoteHarness(makePolicy());

  await E(remote).pull();

  t.deepEqual(fetchedRefspecLists, [[...FETCH_REFSPECS]]);
  t.deepEqual(mergedRefs, ['refs/remotes/origin/zeta']);
});

test('defaultPullRef rejects invalid, wildcard, missing, and ambiguous selectors', t => {
  const cases = harden([
    {
      defaultPullRef: 'main',
      message: /must be fully qualified under refs/,
    },
    {
      defaultPullRef: 'refs/heads/*',
      message: /must select a concrete fetch refspec source/,
    },
    {
      defaultPullRef: 'refs/heads/missing',
      message: /does not select a configured concrete fetch refspec/,
    },
    {
      defaultPullRef: 'refs/heads/zeta',
      fetchRefspecs: [
        '+refs/heads/zeta:refs/remotes/origin/zeta',
        '+refs/heads/zeta:refs/remotes/origin/also-zeta',
      ],
      message: /ambiguous across 2 configured concrete fetch refspecs/,
    },
  ]);

  for (const { defaultPullRef, fetchRefspecs, message } of cases) {
    t.throws(
      () =>
        normalizeGitRemotePolicy({
          name: 'origin',
          policy: {
            ...makePolicy(),
            defaultPullRef,
            ...(fetchRefspecs === undefined ? {} : { fetchRefspecs }),
          },
        }),
      { message },
    );
  }
});
