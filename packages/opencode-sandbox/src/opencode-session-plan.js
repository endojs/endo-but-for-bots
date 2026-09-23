// @ts-check

/**
 * The OpenCode session plan: the placement every hosted session records
 * (`@endo/hosted-agent/session-plan.js`) with OpenCode's own field, the pinned
 * image. The primitives are re-exported so this module remains the package's
 * one plan boundary. Nothing unknown is carried through: a field this parser
 * does not know cannot add authority.
 *
 * @module
 */

import {
  containsPath,
  isNormalizedAbsolutePath,
  makeSandboxSessionId as makeSharedSandboxSessionId,
  readMounterEnv,
  readSessionPlacement,
} from '@endo/hosted-agent/session-plan.js';

/** @typedef {import('@endo/hosted-agent/session-plan.js').MounterEnv} MounterEnv */

export { containsPath, isNormalizedAbsolutePath, readMounterEnv };

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
 * @property {MounterEnv} [mounterEnv] Absent means the host's `mount`/`umount`.
 * @property {string} [model]
 * @property {string} [systemPrompt]
 */

/** @typedef {SessionPlan} RecordedSessionPlan */

/** OpenCode's slug when nothing of a session id survives derivation. */
const SANDBOX_ID_FALLBACK = 'opencode';

/**
 * Parse recorded plan text. The result is the only plan shape the controller
 * activates and the storage owner removes; both refuse anything else rather
 * than defaulting a field.
 * @param {string} text
 * @returns {SessionPlan}
 */
export const readSessionPlan = text => {
  const { placement } = readSessionPlacement(text, {
    label: 'OpenCode',
    sandboxIdFallback: SANDBOX_ID_FALLBACK,
    privatePaths: ['mcpDir'],
  });
  return harden(/** @type {SessionPlan} */ ({ ...placement }));
};
harden(readSessionPlan);

/**
 * Deterministic sandbox session id, with OpenCode's own slug fallback so ids
 * recorded before the shared derivation existed do not change.
 * @param {string} name
 */
export const makeSandboxSessionId = name =>
  makeSharedSandboxSessionId(name, SANDBOX_ID_FALLBACK);
harden(makeSandboxSessionId);
