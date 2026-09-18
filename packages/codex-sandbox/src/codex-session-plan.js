// @ts-check

import { assertCopyData } from '@endo/daemon/copy-data.js';
import { Fail, q } from '@endo/errors';
import {
  containsPath,
  makeSandboxSessionId,
  readMounterEnv,
  readNativeProfile,
  readRecordedPath,
} from '@endo/hosted-agent/session-plan.js';

import { assertContainerMounts } from './codex-hosted-policy.js';
import { readPinnedSliceImage } from './codex-image-reference.js';

/**
 * Copy-only native placement and request policy. Host record/checkpoint and
 * CLI-home placement belong to the exact state provider reference, not to a
 * path supplied by the guest. There is no volume identity or storage lease.
 *
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
 * @property {ReturnType<typeof readNativeProfile>} nativeProfile
 * @property {ReturnType<typeof readMounterEnv>} [mounterEnv]
 * @property {ReturnType<typeof assertContainerMounts>} containerMounts
 * @property {string} [model]
 * @property {string} [reasoningEffort]
 * @property {string} [systemPrompt]
 */

/**
 * Validate the same recorded plan at creation, activation and deletion.
 * Unknown fields do not convey authority and are not used by the controller.
 * @param {string} text
 * @returns {CodexSessionPlan}
 */
export const readCodexSessionPlan = text => {
  const value = JSON.parse(text);
  assertCopyData(harden(value));
  (value && typeof value === 'object' && !Array.isArray(value)) ||
    Fail`Codex session plan must be a record`;
  const recorded = /** @type {Record<string, any>} */ (value);
  (typeof recorded.sessionId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(recorded.sessionId)) ||
    Fail`Invalid Codex session identity`;
  recorded.sandboxSessionId ===
    makeSandboxSessionId(recorded.sessionId, 'codex') ||
    Fail`Codex sandbox identity must derive from its session`;
  readPinnedSliceImage(recorded.imageRef);
  (typeof recorded.accountRef === 'string' &&
    /^[A-Za-z0-9_-]{1,256}$/.test(recorded.accountRef)) ||
    Fail`Codex plan must pin its subscription account`;
  ['off', 'public-internet'].includes(recorded.networkPolicy) ||
    Fail`Unknown Codex network policy`;
  const paths = [];
  for (const name of [
    'workspaceMountPoint',
    'mounterSocketDir',
    'workspaceDir',
    'workspaceHostPath',
  ].filter(
    field =>
      !(
        ['workspaceDir', 'workspaceHostPath'].includes(field) &&
        recorded[field] === undefined
      ),
  )) {
    const nativePath = readRecordedPath(name, recorded[name]);
    for (const other of paths) {
      (!containsPath(other, nativePath) && !containsPath(nativePath, other)) ||
        Fail`Codex plan path ${q(name)} overlaps another recorded path`;
    }
    paths.push(nativePath);
  }
  (recorded.workspaceDir === undefined) !==
    (recorded.workspaceHostPath === undefined) ||
    Fail`Codex plan needs exactly one owned or operator workspace`;
  for (const name of ['model', 'reasoningEffort', 'systemPrompt']) {
    recorded[name] === undefined ||
      typeof recorded[name] === 'string' ||
      Fail`Codex plan ${q(name)} must be text`;
  }
  const nativeProfile = readNativeProfile(recorded.nativeProfile);
  const containerMounts = assertContainerMounts(recorded.containerMounts);
  const mounterEnv =
    recorded.mounterEnv === undefined
      ? undefined
      : readMounterEnv(recorded.mounterEnv);
  return harden(
    /** @type {CodexSessionPlan} */ ({
      sessionId: recorded.sessionId,
      sandboxSessionId: recorded.sandboxSessionId,
      imageRef: recorded.imageRef,
      accountRef: recorded.accountRef,
      networkPolicy: recorded.networkPolicy,
      workspaceMountPoint: recorded.workspaceMountPoint,
      mounterSocketDir: recorded.mounterSocketDir,
      ...(recorded.workspaceDir === undefined
        ? {}
        : { workspaceDir: recorded.workspaceDir }),
      ...(recorded.workspaceHostPath === undefined
        ? {}
        : { workspaceHostPath: recorded.workspaceHostPath }),
      ...(recorded.model === undefined ? {} : { model: recorded.model }),
      ...(recorded.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: recorded.reasoningEffort }),
      ...(recorded.systemPrompt === undefined
        ? {}
        : { systemPrompt: recorded.systemPrompt }),
      nativeProfile,
      containerMounts,
      ...(mounterEnv === undefined ? {} : { mounterEnv }),
    }),
  );
};
harden(readCodexSessionPlan);
