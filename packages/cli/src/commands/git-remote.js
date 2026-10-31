// @ts-check

import os from 'os';

import { E } from '@endo/eventual-send';

import { withEndoHost } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';
import { prompt, promptText } from '../prompt.js';

/** @import { GitRemoteInspection, GitRemoteProfileOptions } from '../git-remote-types.js' */

const FETCH_ONLY_PROFILE = 'fetch-only';
const AGENT_PROFILE = 'agent';

export const GIT_REMOTE_PROFILES = harden([FETCH_ONLY_PROFILE, AGENT_PROFILE]);

/**
 * @param {string} remoteName
 * @param {string} url
 * @param {string} profile
 * @param {string[]} branches
 * @returns {GitRemoteProfileOptions}
 */
export const makeGitRemoteProfile = (
  remoteName,
  url,
  profile,
  branches = [],
) => {
  if (!GIT_REMOTE_PROFILES.includes(profile)) {
    throw new Error(
      `Unknown Git remote profile ${JSON.stringify(profile)}; expected ${GIT_REMOTE_PROFILES.join(
        ' or ',
      )}`,
    );
  }
  if (profile === FETCH_ONLY_PROFILE && branches.length > 0) {
    throw new Error('--branch requires the agent profile');
  }

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
        : branches.map(branch =>
            branch.startsWith('refs/') ? branch : `refs/heads/${branch}`,
          ),
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
 * @param {GitRemoteInspection} inspection
 */
export const formatGitRemoteInspection = ({ policy, credential }) => {
  const lines = [
    `${policy.name}`,
    `  endpoint: ${policy.url}`,
    `  state: ${policy.revoked ? 'revoked' : 'active'}`,
    `  directions: ${policy.allowedDirections.join(', ')}`,
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
 * @param {object} host
 * @param {object} remote
 */
const inspectRemote = async (host, remote) => {
  const controller = E(host).getGitRemoteController(remote);
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
  const endpointUrl = url || (await promptText('Remote HTTPS URL:'));
  const profileOptions = makeGitRemoteProfile(
    remoteName,
    endpointUrl,
    profile,
    branches,
  );

  if (!approve) {
    const preview = formatGitRemoteInspection({
      policy: {
        ...profileOptions,
        pushRefspecs:
          profileOptions.allowedBranches?.map(
            branch => `${branch}:${branch}`,
          ) ??
          profileOptions.pushRefspecs ??
          [],
        revoked: false,
      },
      credential: {
        required: true,
        kind: 'existing',
        audience: 'bound to endpoint',
        available: true,
        revoked: false,
      },
    });
    console.log(preview);
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
      parsePetNamePath(remoteName),
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
