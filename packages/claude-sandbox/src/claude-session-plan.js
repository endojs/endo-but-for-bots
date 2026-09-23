// @ts-check

/**
 * The Claude session plan: the placement every hosted session records
 * (`@endo/hosted-agent/session-plan.js`) with Claude's own fields. The plan is
 * the passive record the daemon session owner keeps for one logical session;
 * the native controller activates it and the storage owner removes it, and
 * both refuse any deviation in the recorded fields. Nothing unknown is
 * admitted: a plan with a field this parser does not know is refused.
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

import { assertCredentialKind } from './claude-credential-kinds.js';
import { assertClaudeEffort } from './claude-effort.js';

/** @typedef {import('@endo/hosted-agent/session-plan.js').MounterEnv} MounterEnv */

export { containsPath, isNormalizedAbsolutePath, readMounterEnv };

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
 * @property {string} accountRef The account authority the session is bound
 *   to (`@endo/hosted-agent/account-authority.js`).
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
 * @property {MounterEnv} [mounterEnv] Absent means the host's `mount`/`umount`.
 * @property {string} [model]
 * @property {string} [reasoningEffort]
 * @property {string} [systemPrompt]
 * @property {string} [subscription]
 */

/**
 * The recorded plan uses the same copy-data fields as the parsed plan.
 * @typedef {ClaudeSessionPlan} RecordedClaudeSessionPlan
 */

/** Claude's slug when nothing of a session id survives derivation. */
const SANDBOX_ID_FALLBACK = 'claude';

/**
 * Parse recorded plan text. The result is the only plan shape the controller
 * activates and the storage owner removes; every recorded field is checked
 * and none is defaulted.
 * @param {string} text
 * @returns {ClaudeSessionPlan}
 */
export const readClaudeSessionPlan = text => {
  const { placement, recorded } = readSessionPlacement(text, {
    label: 'Claude',
    sandboxIdFallback: SANDBOX_ID_FALLBACK,
    privatePaths: ['mcpDir'],
    fields: ['credentialKind'],
    assertEffort: assertClaudeEffort,
  });
  return harden(
    /** @type {ClaudeSessionPlan} */ ({
      ...placement,
      credentialKind: assertCredentialKind(recorded.credentialKind),
    }),
  );
};
harden(readClaudeSessionPlan);

/**
 * Deterministic sandbox session id with Claude's own slug fallback, so ids
 * recorded before the shared derivation existed do not change.
 * @param {string} name
 */
export const makeSandboxSessionId = name =>
  makeSharedSandboxSessionId(name, SANDBOX_ID_FALLBACK);
harden(makeSandboxSessionId);
