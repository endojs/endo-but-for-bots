// @ts-check

import os from 'os';

import { E } from '@endo/eventual-send';

import { withEndoHost } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';
import { prompt, promptText } from '../prompt.js';

/**
 * @import { ERef } from '@endo/eventual-send'
 * @import {
 *   GitRemoteCap,
 *   GitRemoteController,
 *   GitRemoteHost,
 *   GitRemoteInspection,
 *   GitRemotePolicyView,
 *   GitRemoteProfile,
 *   GitRemoteProfileOptions,
 * } from '../git-remote-types.js'
 */

const FETCH_ONLY_PROFILE = 'fetch-only';
const AGENT_PROFILE = 'agent';

/** @type {readonly GitRemoteProfile[]} */
export const GIT_REMOTE_PROFILES = harden([FETCH_ONLY_PROFILE, AGENT_PROFILE]);

/**
 * @param {string} profile
 * @returns {profile is GitRemoteProfile}
 */
const isGitRemoteProfile = profile =>
  /** @type {readonly string[]} */ (GIT_REMOTE_PROFILES).includes(profile);

/**
 * A Git remote name becomes the `refs/remotes/<name>/` fetch destination, so
 * it must be a single plain segment.
 *
 * @param {string} remoteName
 */
const assertGitRemoteName = remoteName => {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remoteName) ||
    remoteName.includes('..') ||
    remoteName.endsWith('.lock')
  ) {
    throw new Error(
      `Git remote name ${JSON.stringify(remoteName)} must be a single segment of letters, digits, ".", "_", or "-"`,
    );
  }
};

/**
 * @param {string} url
 */
const assertHttpsEndpoint = url => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Git remote URL ${JSON.stringify(url)} is not a valid URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Git remote URL ${JSON.stringify(url)} must use https:`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(
      'Git remote URL must not embed credentials; name a credential capability with --credential',
    );
  }
};

/**
 * Normalizes one agent-profile branch selector to a ref under
 * `refs/heads/`, rejecting selectors that would widen the grant past a
 * bounded branch namespace.
 *
 * @param {string} branch
 * @returns {string}
 */
const normalizeAgentBranch = branch => {
  const label = JSON.stringify(branch);
  if (
    branch === '' ||
    /[\s~^:?[\\]/.test(branch) ||
    branch.startsWith('+') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.includes('@{')
  ) {
    throw new Error(`--branch ${label} is not a valid branch selector`);
  }
  if (branch.startsWith('refs/') && !branch.startsWith('refs/heads/')) {
    throw new Error(`--branch ${label} must name a ref under refs/heads/`);
  }
  const ref = branch.startsWith('refs/heads/')
    ? branch
    : `refs/heads/${branch}`;
  const wildcards = [...ref].filter(ch => ch === '*').length;
  if (wildcards > 1 || (wildcards === 1 && !ref.endsWith('/*'))) {
    throw new Error(
      `--branch ${label} may only end in a single /* under a fixed parent`,
    );
  }
  if (ref === 'refs/heads/*') {
    throw new Error(
      `--branch ${label} would grant every branch; name a narrower namespace`,
    );
  }
  return ref;
};

/**
 * @param {string} remoteName - Git remote name; the fetch destination is
 *   `refs/remotes/<remoteName>/*`.
 * @param {string} url - Fixed HTTPS endpoint without embedded credentials.
 * @param {string} profile - One of {@link GIT_REMOTE_PROFILES}.
 * @param {string[]} [branches] - Agent-profile branch selectors.
 * @returns {GitRemoteProfileOptions}
 */
export const makeGitRemoteProfile = (
  remoteName,
  url,
  profile,
  branches = [],
) => {
  if (!isGitRemoteProfile(profile)) {
    throw new Error(
      `Unknown Git remote profile ${JSON.stringify(profile)}; expected ${GIT_REMOTE_PROFILES.join(
        ' or ',
      )}`,
    );
  }
  if (profile === FETCH_ONLY_PROFILE && branches.length > 0) {
    throw new Error('--branch requires the agent profile');
  }
  assertGitRemoteName(remoteName);
  assertHttpsEndpoint(url);

  const fetchRefspecs = harden([`+refs/heads/*:refs/remotes/${remoteName}/*`]);
  if (profile === FETCH_ONLY_PROFILE) {
    return harden({
      name: remoteName,
      url,
      allowedDirections: harden(['fetch']),
      fetchRefspecs,
      pushRefspecs: harden([]),
      allowForcePush: false,
      allowTags: false,
      allowDelete: false,
    });
  }

  return harden({
    name: remoteName,
    url,
    allowedDirections: harden(['fetch', 'push']),
    fetchRefspecs,
    allowedBranches: harden(
      branches.length === 0
        ? ['refs/heads/agent/*']
        : [...new Set(branches.map(normalizeAgentBranch))],
    ),
    allowForcePush: false,
    allowTags: false,
    allowDelete: false,
  });
};
harden(makeGitRemoteProfile);

/**
 * @param {unknown} value
 */
const enabledText = value => (value ? 'allowed' : 'denied');

/**
 * @param {GitRemotePolicyView} policy
 * @returns {string[]}
 */
const formatGitRemotePolicyLines = policy => [
  `${policy.name}`,
  `  endpoint: ${policy.url}`,
  `  state: ${policy.revoked ? 'revoked' : 'active'}`,
  `  directions: ${policy.allowedDirections.length === 0 ? '(none)' : policy.allowedDirections.join(', ')}`,
  '  fetch targets:',
  ...(policy.fetchRefspecs.length === 0
    ? ['    (none)']
    : policy.fetchRefspecs.map(refspec => `    ${refspec}`)),
  '  push targets:',
  ...(policy.pushRefspecs.length === 0
    ? ['    (none)']
    : policy.pushRefspecs.map(refspec => `    ${refspec}`)),
  `  force push: ${enabledText(policy.allowForcePush)}`,
  `  tag transfer: ${enabledText(policy.allowTags)}`,
  `  deletion: ${enabledText(policy.allowDelete)}`,
];

/**
 * @param {GitRemoteInspection} inspection
 */
export const formatGitRemoteInspection = ({ policy, credential }) => {
  const lines = formatGitRemotePolicyLines(policy);
  if (credential.required) {
    lines.push(
      `  credential: ${credential.kind} for ${credential.audience} (${credential.available && !credential.revoked ? 'available' : 'unavailable'})`,
    );
  } else {
    lines.push('  credential: not required');
  }
  return lines.join('\n');
};
harden(formatGitRemoteInspection);

/**
 * Renders the grant a provisioning request asks for, before the daemon has
 * seen it. Push targets follow the daemon's derivation of one
 * `<ref>:<ref>` refspec per allowed branch. The credential is only named here:
 * its health is unknown until the daemon binds it, so the preview says so
 * rather than claiming it is available.
 *
 * @param {GitRemoteProfileOptions} profileOptions
 * @param {string} credentialName
 */
export const formatGitRemotePreview = (profileOptions, credentialName) => {
  const { allowedBranches, pushRefspecs = [] } = profileOptions;
  const lines = formatGitRemotePolicyLines({
    ...profileOptions,
    pushRefspecs:
      allowedBranches === undefined
        ? pushRefspecs
        : allowedBranches.map(ref => `${ref}:${ref}`),
    revoked: false,
  });
  lines.push(
    `  credential: ${credentialName} (unverified; health is reported after provisioning)`,
  );
  return lines.join('\n');
};
harden(formatGitRemotePreview);

/**
 * @param {ERef<GitRemoteHost>} host
 * @param {ERef<GitRemoteCap>} remote
 * @returns {Promise<GitRemoteInspection>}
 */
const inspectRemote = async (host, remote) => {
  const controller = /** @type {Promise<GitRemoteController>} */ (
    E(host).getGitRemoteController(remote)
  );
  const [policy, credential] = await Promise.all([
    E(controller).inspect(),
    E(remote).credentialHealth(),
  ]);
  return harden({ policy, credential });
};

/**
 * @param {object} options
 * @param {string} options.gitName
 * @param {string} options.remoteName
 * @param {string | undefined} options.url
 * @param {string} options.profile
 * @param {string[]} options.branches
 * @param {string} options.credentialName
 * @param {boolean} options.approve
 * @param {boolean} options.asJson
 */
export const provisionGitRemote = async ({
  gitName,
  remoteName,
  url,
  profile,
  branches,
  credentialName,
  approve,
  asJson,
}) => {
  await null;
  if (approve && !url) {
    throw new Error(
      '--yes requires --url; the endpoint prompt needs a terminal',
    );
  }
  const remotePath = parsePetNamePath(remoteName);
  const endpointUrl = url || (await promptText('Remote HTTPS URL:'));
  const profileOptions = makeGitRemoteProfile(
    remotePath[remotePath.length - 1],
    endpointUrl,
    profile,
    branches,
  );

  if (!approve) {
    console.log(formatGitRemotePreview(profileOptions, credentialName));
    const answer = await prompt('Provision this remote? (yes/no)');
    if (answer !== 'yes' && answer !== 'y') {
      console.log('Remote was not provisioned.');
      return;
    }
  }

  await withEndoHost({ os, process }, async ({ host }) => {
    const git = await E(host).lookup(...parsePetNamePath(gitName));
    const credential = await E(host).lookup(
      ...parsePetNamePath(credentialName),
    );
    const remote = await E(host).provideGitRemote(
      git,
      remotePath,
      harden({
        ...profileOptions,
        credential,
      }),
    );
    const inspection = await inspectRemote(host, remote);
    console.log(
      asJson
        ? JSON.stringify(inspection, null, 2)
        : formatGitRemoteInspection(inspection),
    );
  });
};

/**
 * @param {object} options
 * @param {string} options.remoteName
 * @param {boolean} options.asJson
 */
export const inspectGitRemote = async ({ remoteName, asJson }) =>
  withEndoHost({ os, process }, async ({ host }) => {
    const remote = await E(host).lookup(...parsePetNamePath(remoteName));
    const inspection = await inspectRemote(host, remote);
    console.log(
      asJson
        ? JSON.stringify(inspection, null, 2)
        : formatGitRemoteInspection(inspection),
    );
  });
