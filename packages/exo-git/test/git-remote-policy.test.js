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
