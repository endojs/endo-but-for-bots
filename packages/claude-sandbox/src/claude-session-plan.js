// @ts-check

/**
 * The Claude session plan: the adapter-agnostic primitives of
 * `@endo/hosted-agent/session-plan.js` composed with Claude's own field list.
 * The plan is the passive record the daemon session owner keeps for one
 * logical session; the native controller activates it and the storage owner
 * removes it, and both refuse any deviation in the recorded fields (unknown
 * fields are carried through unread).
 *
 * @module
 */

import { assertCopyData } from '@endo/daemon/copy-data.js';
import { Fail, q } from '@endo/errors';
import {
  containsPath,
  isNormalizedAbsolutePath,
  makeSandboxSessionId as makeSharedSandboxSessionId,
  readMounterEnv,
  readNativeProfile,
  readRecordedPath,
} from '@endo/hosted-agent/session-plan.js';

import { assertCredentialKind } from './claude-credential-kinds.js';

/** @import { assertNativePodmanProfile } from '@endo/sandbox/native-podman-profile.js' */
/** @typedef {import('@endo/hosted-agent/session-plan.js').PlanNativeProfile} PlanNativeProfile */
/** @typedef {import('@endo/hosted-agent/session-plan.js').MounterEnv} MounterEnv */

export {
  containsPath,
  isNormalizedAbsolutePath,
  readMounterEnv,
  readNativeProfile,
};

/**
 * The approved plan for one logical Claude session. Every path is host
 * storage this plan owns; none may contain another, and the guest never sees
 * these strings. The slice joins the broker's network namespace: the CLI
 * reaches only the listener's loopback endpoint, and the host injects the
 * credential upstream under the header its kind needs.
 * @typedef {object} ClaudeSessionPlan
 * @property {string} sessionId
 * @property {string} sandboxSessionId
 * @property {string} rootfs Explicit effective image; no environment fallback.
 * @property {'off' | 'public-internet'} networkPolicy
 * @property {'apiKey' | 'oauthToken'} credentialKind The broker's credential
 *   kind, recorded so the controller places the CLI's placeholder under the
 *   variable the CLI reads for that kind.
 * @property {string} [workspaceDir] Owned backing storage the workspace
 *   filesystem serves; absent when the workspace is an operator-supplied host
 *   path that this session's storage owner must never remove.
 * @property {string} [workspaceHostPath] The operator-supplied workspace the
 *   controller projects instead; recorded so a later request cannot silently
 *   rebind the session to different storage. Never removed.
 * @property {string} workspaceMountPoint Kernel mount, distinct from backing storage.
 * @property {string} mcpDir Private, recorded native socket/relay directory.
 * @property {string} mounterSocketDir Private 9P socket parent, never guest-visible.
 * @property {ReturnType<typeof assertNativePodmanProfile>} nativeProfile
 * @property {MounterEnv} [mounterEnv] Absent means the host's `mount`/`umount`.
 * @property {string} [model]
 * @property {string} [systemPrompt]
 */

/**
 * The plan as recorded: the same fields with the two OCI quantities still in
 * their decimal-string form. `readClaudeSessionPlan` widens it.
 * @typedef {Omit<ClaudeSessionPlan, 'nativeProfile'> & { nativeProfile: PlanNativeProfile }} RecordedClaudeSessionPlan
 */

const NETWORK_POLICIES = harden(['off', 'public-internet']);
const RECORDED_PATHS = harden([
  'workspaceMountPoint',
  'mcpDir',
  'mounterSocketDir',
]);
const OPTIONAL_PATHS = harden(['workspaceDir', 'workspaceHostPath']);
const OPTIONAL_TEXT = harden(['model', 'systemPrompt']);

/**
 * Parse recorded plan text. The result is the only plan shape the controller
 * activates and the storage owner removes; every recorded field is checked
 * and none is defaulted, while unknown fields are carried through unread.
 * @param {string} text
 * @returns {ClaudeSessionPlan}
 */
export const readClaudeSessionPlan = text => {
  const value = JSON.parse(text);
  assertCopyData(harden(value));
  (typeof value === 'object' && value !== null && !Array.isArray(value)) ||
    Fail`Session plan must be a record`;
  /** @type {Record<string, unknown>} */
  const recorded = value;
  for (const name of ['sessionId', 'sandboxSessionId', 'rootfs']) {
    (typeof recorded[name] === 'string' && recorded[name] !== '') ||
      Fail`Missing session plan field ${q(name)}`;
  }
  NETWORK_POLICIES.includes(/** @type {string} */ (recorded.networkPolicy)) ||
    Fail`Unknown session plan network policy`;
  assertCredentialKind(recorded.credentialKind);
  for (const name of OPTIONAL_TEXT) {
    recorded[name] === undefined ||
      typeof recorded[name] === 'string' ||
      Fail`Session plan field ${q(name)} must be text`;
  }
  /** @type {[string, string][]} */
  const paths = [];
  for (const name of [...RECORDED_PATHS, ...OPTIONAL_PATHS]) {
    if (OPTIONAL_PATHS.includes(name) && recorded[name] === undefined) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const nativePath = readRecordedPath(name, recorded[name]);
    for (const [otherName, other] of paths) {
      (!containsPath(other, nativePath) && !containsPath(nativePath, other)) ||
        Fail`Session plan paths ${q(otherName)} and ${q(name)} must be disjoint`;
    }
    paths.push([name, nativePath]);
  }
  if (recorded.workspaceHostPath !== undefined) {
    recorded.workspaceDir === undefined ||
      Fail`Session plan cannot record both an owned and an operator-supplied workspace`;
  } else {
    recorded.workspaceDir !== undefined ||
      Fail`Session plan must record an owned or an operator-supplied workspace`;
  }
  const nativeProfile = readNativeProfile(recorded.nativeProfile);
  const mounterEnv =
    recorded.mounterEnv === undefined
      ? undefined
      : readMounterEnv(recorded.mounterEnv);
  return harden(
    /** @type {ClaudeSessionPlan} */ ({
      ...recorded,
      nativeProfile,
      ...(mounterEnv === undefined ? {} : { mounterEnv }),
    }),
  );
};
harden(readClaudeSessionPlan);

/**
 * Deterministic sandbox session id with Claude's own slug fallback.
 * @param {string} name
 */
export const makeSandboxSessionId = name =>
  makeSharedSandboxSessionId(name, 'claude');
harden(makeSandboxSessionId);
