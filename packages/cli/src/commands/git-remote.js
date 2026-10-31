// @ts-check

import os from 'os';
import { stderr } from 'process';

import { Fail, b, q } from '@endo/errors';
import { E } from '@endo/eventual-send';

import { withEndoHost } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';
import { makePrompter } from '../prompt.js';

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
    Fail`Git remote name ${q(remoteName)} must be a single segment of letters, digits, ".", "_", or "-"`;
  }
};

/**
 * C0 and C1 controls, DEL, and the Unicode bidirectional overrides can
 * rewrite or hide what a terminal shows, so no value rendered in the
 * approval preview may carry them.
 */
const TERMINAL_CONTROL_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/**
 * @param {string} value
 * @param {string} label
 */
const assertNoTerminalControls = (value, label) => {
  !TERMINAL_CONTROL_PATTERN.test(value) ||
    Fail`${b(label)} ${q(value)} must not contain control or bidirectional-override characters`;
};

/**
 * @param {string} url
 */
const assertHttpsEndpoint = url => {
  assertNoTerminalControls(url, 'Git remote URL');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw Fail`Git remote URL ${q(url)} is not a valid URL`;
  }
  parsed.protocol === 'https:' ||
    Fail`Git remote URL ${q(url)} must use https:`;
  (parsed.username === '' && parsed.password === '') ||
    Fail`Git remote URL must not embed credentials; name a credential capability with --credential`;
};

/**
 * Applies the component rules of `git check-ref-format` to a ref under
 * `refs/heads/`. A trailing `*` component is the selector's wildcard and was
 * validated by the caller.
 *
 * @param {string} ref
 */
const isValidBranchRef = ref => {
  const components = ref.split('/');
  if (components[components.length - 1] === '*') {
    components.pop();
  }
  return (
    !ref.endsWith('.') &&
    components.every(
      component =>
        component !== '' &&
        !component.startsWith('.') &&
        !component.endsWith('.lock') &&
        // eslint-disable-next-line no-control-regex
        !/[\u0000-\u0020\u007f~^:?*[\\]/.test(component),
    )
  );
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
  const label = q(branch);
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
    Fail`--branch ${label} is not a valid branch selector`;
  }
  if (branch.startsWith('refs/') && !branch.startsWith('refs/heads/')) {
    Fail`--branch ${label} must name a ref under refs/heads/`;
  }
  const ref = branch.startsWith('refs/heads/')
    ? branch
    : `refs/heads/${branch}`;
  const wildcards = [...ref].filter(character => character === '*').length;
  if (wildcards > 1 || (wildcards === 1 && !ref.endsWith('/*'))) {
    Fail`--branch ${label} may only end in a single /* under a fixed parent`;
  }
  if (ref === 'refs/heads/*') {
    Fail`--branch ${label} would grant every branch; name a narrower namespace`;
  }
  isValidBranchRef(ref) ||
    Fail`--branch ${label} is not a valid branch selector`;
  return ref;
};

/**
 * @param {string} remoteName - Git remote name; the fetch destination is
 *   `refs/remotes/<remoteName>/*`.
 * @param {string} url - Fixed HTTPS endpoint without embedded credentials.
 * @param {string} profile - One of {@link GIT_REMOTE_PROFILES}.
 * @param {readonly string[]} [branches] - Agent-profile branch selectors.
 * @returns {GitRemoteProfileOptions}
 */
export const makeGitRemoteProfile = (
  remoteName,
  url,
  profile,
  branches = [],
) => {
  isGitRemoteProfile(profile) ||
    Fail`Unknown Git remote profile ${q(profile)}; expected fetch-only or agent`;
  !(profile === FETCH_ONLY_PROFILE && branches.length > 0) ||
    Fail`--branch requires the agent profile`;
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
  if (credential === undefined) {
    lines.push('  credential: not checked (remote revoked)');
  } else if (credential.required) {
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
 * Reads the policy through the host-held controller rather than the remote's
 * own `inspect()`: the CLI already acts with the host's authority, and only
 * the controller can still report a remote after revocation, when every
 * guest-facing method, `credentialHealth()` included, rejects.
 *
 * @param {ERef<GitRemoteHost>} host
 * @param {ERef<GitRemoteCap>} remote
 * @returns {Promise<GitRemoteInspection>}
 */
const inspectRemote = async (host, remote) => {
  const controller = /** @type {Promise<GitRemoteController>} */ (
    E(host).getGitRemoteController(remote)
  );
  const policy = await E(controller).inspect();
  if (policy.revoked) {
    return harden({ policy });
  }
  const credential = await E(remote).credentialHealth();
  return harden({ policy, credential });
};

/**
 * @param {object} options
 * @param {string} options.gitName
 * @param {string} options.remoteName
 * @param {string | undefined} options.url
 * @param {string} options.profile
 * @param {readonly string[]} options.branches
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
  !(approve && !url) ||
    Fail`--yes requires --url; the endpoint prompt needs a terminal`;
  assertNoTerminalControls(credentialName, '--credential');
  const remotePath = parsePetNamePath(remoteName);
  const remoteSegment = remotePath[remotePath.length - 1];
  /** @type {GitRemoteProfileOptions} */
  let profileOptions;
  if (approve) {
    profileOptions = makeGitRemoteProfile(
      remoteSegment,
      /** @type {string} */ (url),
      profile,
      branches,
    );
  } else {
    // The preview and prompts go to stderr so stdout carries only the
    // resulting inspection, which `--json` makes one parseable document.
    const prompter = makePrompter(stderr);
    try {
      const endpointUrl = url || (await prompter.ask('Remote HTTPS URL:'));
      profileOptions = makeGitRemoteProfile(
        remoteSegment,
        endpointUrl,
        profile,
        branches,
      );
      console.error(formatGitRemotePreview(profileOptions, credentialName));
      const answer = (
        await prompter.ask('Provision this remote? (yes/no)')
      ).toLowerCase();
      if (answer !== 'yes' && answer !== 'y') {
        console.error('Remote was not provisioned.');
        return;
      }
    } finally {
      prompter.close();
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
harden(provisionGitRemote);

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
harden(inspectGitRemote);
