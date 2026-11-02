// @ts-check

/**
 * The Codex session plan: the placement every hosted session records
 * (`@endo/hosted-agent/session-plan.js`) with Codex's own fields: the pinned
 * slice image, the subscription account and the operator's container mounts.
 * Host record/checkpoint and CLI-home placement belong to the exact state
 * provider reference; its operator-configured root is pinned as stateRoot,
 * never supplied by the guest. There is no volume
 * identity or storage lease, and no MCP directory. Nothing unknown is
 * admitted: a plan with a field this parser does not know is refused.
 *
 * @module
 */

import {
  readRecordedPath,
  readSessionPlacement,
} from '@endo/hosted-agent/session-plan.js';

import { assertContainerMounts } from './codex-hosted-policy.js';

/**
 * @typedef {object} CodexSessionPlan
 * @property {string} sessionId
 * @property {string} sandboxSessionId
 * @property {string} rootfs The pinned slice image, `oci:<image>@<digest>`.
 * @property {string} stateRoot Immutable root of host records and CLI homes.
 * @property {string} accountRef The account authority the session is bound
 *   to (`@endo/hosted-agent/account-authority.js`).
 * @property {'off' | 'public-internet'} networkPolicy
 * @property {string} workspaceMountPoint
 * @property {string} mounterSocketDir
 * @property {string} [workspaceDir]
 * @property {string} [workspaceHostPath]
 * @property {string} [subscription] A subscription id; absent leaves the
 *   session to the broker's pool.
 * @property {import('@endo/hosted-agent/session-plan.js').MounterEnv} [mounterEnv]
 * @property {ReturnType<typeof assertContainerMounts>} containerMounts
 * @property {string} [model]
 * @property {string} [reasoningEffort]
 * @property {string} [systemPrompt]
 */

/**
 * Validate the same recorded plan at creation, activation and deletion.
 * @param {string} text
 * @returns {CodexSessionPlan}
 */
export const readCodexSessionPlan = text => {
  const { placement, recorded } = readSessionPlacement(text, {
    label: 'Codex',
    sandboxIdFallback: 'codex',
    fields: ['containerMounts', 'stateRoot'],
  });
  return harden(
    /** @type {CodexSessionPlan} */ ({
      ...placement,
      stateRoot: readRecordedPath('stateRoot', recorded.stateRoot),
      containerMounts: assertContainerMounts(recorded.containerMounts),
    }),
  );
};
harden(readCodexSessionPlan);
