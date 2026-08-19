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
  makeBasicCredential,
  makeBearerCredential,
  makeUnavailableGitCredential,
  getGitCredentialController,
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
  const { remote, controller } = makeGitRemote({
    git,
    operations,
    name: 'origin',
    policy,
  });
  return { fetchedRefspecLists, mergedRefs, remote, controller };
};

/**
 * The fallback `makeHelp` yields for a method it has no entry for.
 * Spelled out here rather than imported so the test pins the wording a
 * caller actually sees.
 *
 * @param {string} method
 * @returns {string}
 */
const unknownMethodHelp = method =>
  `No documentation available for method "${method}".`;

test('Git remote and credential capabilities document every method they advertise', async t => {
  const { remote, controller } = makeRemoteHarness(makePolicy());
  const bearer = makeBearerCredential({
    audience: 'https://github.com',
    token: 'test-token',
  });
  const basic = makeBasicCredential({
    audience: 'https://github.com',
    username: 'test-user',
    password: 'test-password',
  });
  const credentialController = getGitCredentialController(bearer);
  t.truthy(credentialController);
  for (const [entity, capability] of /** @type {const} */ ([
    ['GitRemote', remote],
    ['GitRemoteController', controller],
    ['GitCredentialController', credentialController],
    ['BearerCredential', bearer],
    ['BasicCredential', basic],
  ])) {
    // eslint-disable-next-line no-underscore-dangle, no-await-in-loop
    const advertised = await E(
      /** @type {any} */ (capability),
    ).__getMethodNames__();
    const methods = advertised.filter(
      /** @param {string} name */
      name => !name.startsWith('__'),
    );
    // eslint-disable-next-line no-await-in-loop
    const [overview, unknown, ...docs] = await Promise.all([
      E(capability).help(),
      E(capability).help('unknownMethod'),
      .../** @type {string[]} */ (methods).map(method =>
        E(capability).help(method),
      ),
    ]);
    t.true(
      overview.startsWith(`${entity} - `),
      `${entity} overview must be its own entity overview`,
    );
    /** @type {string[]} */ (methods).forEach((method, index) => {
      const doc = docs[index];
      t.not(doc, '', `${entity}.${method} must have documentation`);
      t.not(
        doc,
        unknownMethodHelp(method),
        `${entity}.${method} must have per-method documentation, not the fallback`,
      );
      t.true(
        doc.startsWith(`${method}(`),
        `${entity}.${method} documentation must open with its signature`,
      );
    });
    t.is(unknown, unknownMethodHelp('unknownMethod'));
  }
});

test('an unavailable credential documents its own credential kind', async t => {
  const unavailable = makeUnavailableGitCredential({
    kind: 'basic',
    audience: 'https://github.com',
  });
  const overview = await E(unavailable).help();
  t.true(overview.startsWith('BasicCredential - '));
  t.true((await E(unavailable).help('audience')).startsWith('audience('));
});

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
