// @ts-check

/**
 * The Codex session plan: the placement every hosted session records
 * (`@endo/hosted-agent/session-plan.js`) with Codex's own fields: the pinned
 * slice image, the subscription account and the operator's container mounts.
 * Host record/checkpoint and CLI-home placement belong to the exact state
 * provider reference, not to a path supplied by the guest. There is no volume
 * identity or storage lease, and no MCP directory. Nothing unknown is carried
 * through: a field this parser does not know cannot add authority.
 *
 * @module
 */

import { Fail } from '@endo/errors';
import { readSessionPlacement } from '@endo/hosted-agent/session-plan.js';

import { assertContainerMounts } from './codex-hosted-policy.js';
import { readPinnedSliceImage } from './codex-image-reference.js';

/**
 * @typedef {object} CodexSessionPlan
 * @property {string} sessionId
 * @property {string} sandboxSessionId
 * @property {string} imageRef
 * @property {string} accountRef
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
  });
  readPinnedSliceImage(recorded.imageRef);
  (typeof recorded.accountRef === 'string' &&
    /^[A-Za-z0-9_-]{1,256}$/.test(recorded.accountRef)) ||
    Fail`Codex plan must pin its subscription account`;
  return harden(
    /** @type {CodexSessionPlan} */ ({
      ...placement,
      imageRef: recorded.imageRef,
      accountRef: recorded.accountRef,
      containerMounts: assertContainerMounts(recorded.containerMounts),
    }),
  );
};
harden(readCodexSessionPlan);
