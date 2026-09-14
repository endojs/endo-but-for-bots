// @ts-check

/**
 * The OpenCode session plan: the adapter-agnostic primitives of
 * `@endo/hosted-agent/session-plan.js` composed with OpenCode's own field
 * list. The primitives are re-exported so this module remains the package's
 * one plan boundary.
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
 * The approved plan for one logical session, recorded passively by the daemon
 * owner and read again by the native controller at activation and by the
 * storage owner at removal. Every path is host storage this plan owns; none
 * may contain another, and the controller's guest never sees these strings.
 * @typedef {object} SessionPlan
 * @property {string} sessionId
 * @property {string} sandboxSessionId
 * @property {string} rootfs Explicit effective image; no environment fallback.
 * @property {'off' | 'public-internet'} networkPolicy
 * @property {string} [workspaceDir] Owned backing storage the workspace
 *   filesystem serves; absent when the workspace is an operator-supplied host
 *   path that this session's storage owner must never remove.
 * @property {string} [workspaceHostPath] The operator-supplied workspace the
 *   controller projects instead; recorded so a later request cannot silently
 *   rebind the session to different storage, and disjoint from every other
 *   recorded path so the guest never sees its own sockets or mount point.
 *   Never removed.
 * @property {string} workspaceMountPoint Kernel mount, distinct from backing storage.
 * @property {string} mcpDir Private, recorded native socket/relay directory.
 * @property {string} mounterSocketDir Private 9P socket parent, never guest-visible.
 * @property {ReturnType<typeof assertNativePodmanProfile>} nativeProfile
 * @property {MounterEnv} [mounterEnv] Absent means the host's `mount`/`umount`.
 * @property {string} [model]
 * @property {string} [systemPrompt]
 * @property {string} [opencodeSessionId]
 */

/**
 * The plan as recorded: the same fields with the two OCI quantities still in
 * their decimal-string form. `readSessionPlan` widens it into a `SessionPlan`.
 * @typedef {Omit<SessionPlan, 'nativeProfile'> & { nativeProfile: PlanNativeProfile }} RecordedSessionPlan
 */

const NETWORK_POLICIES = harden(['off', 'public-internet']);
const RECORDED_PATHS = harden([
  'workspaceMountPoint',
  'mcpDir',
  'mounterSocketDir',
]);
const OPTIONAL_PATHS = harden(['workspaceDir', 'workspaceHostPath']);
const OPTIONAL_TEXT = harden(['model', 'systemPrompt', 'opencodeSessionId']);

/**
 * Parse recorded plan text. The result is the only plan shape the controller
 * activates and the storage owner removes; both refuse anything else rather
 * than defaulting a field.
 * @param {string} text
 * @returns {SessionPlan}
 */
export const readSessionPlan = text => {
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
    /** @type {SessionPlan} */ ({
      ...recorded,
      nativeProfile,
      ...(mounterEnv === undefined ? {} : { mounterEnv }),
    }),
  );
};
harden(readSessionPlan);

/**
 * Deterministic sandbox session id, with OpenCode's own slug fallback so ids
 * recorded before the shared derivation existed do not change.
 * @param {string} name
 */
export const makeSandboxSessionId = name =>
  makeSharedSandboxSessionId(name, 'opencode');
harden(makeSandboxSessionId);
