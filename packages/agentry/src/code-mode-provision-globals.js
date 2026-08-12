// @ts-check
/// <reference types="ses"/>

/** @import { CodeModeGlobal } from '@endo/agent-tools/code-mode/evaluate-tool.js' */
/** @import { EndoProvisionPersistence } from './code-mode-provisioning-types.js' */

import { makeWorkspaceGlobal } from '@endo/agent-tools/code-mode-globals/fs.js';
import { makeGitGlobal } from '@endo/agent-tools/code-mode-globals/git.js';
import { makeGitRemoteGlobal } from '@endo/agent-tools/code-mode-globals/git-remote.js';
import { normalizeGlobals } from '@endo/agent-tools/code-mode/declarations.js';

/**
 * Select prompt descriptors from normalized policy. This helper is exported
 * from the source module for focused tests; the public subpath filters it out.
 *
 * @param {EndoProvisionPersistence} persistence
 * @returns {CodeModeGlobal[]}
 */
export const makeEndoProvisionGlobals = persistence => {
  const { policy } = persistence;
  /** @type {CodeModeGlobal[]} */
  const globals = [];
  for (const name of Object.keys(policy.mounts).sort()) {
    if (policy.mounts[name].guestBinding) {
      globals.push(makeWorkspaceGlobal({ name }));
    }
  }
  const gits = policy.gits ?? {};
  for (const name of Object.keys(gits).sort()) {
    const grant = gits[name];
    globals.push(
      makeGitGlobal({
        name,
        readOnly: grant.mode === 'readOnly',
        historyRewrite: grant.mode === 'historyRewrite',
      }),
    );
  }
  for (const name of Object.keys(policy.gitRemotes ?? {}).sort()) {
    globals.push(makeGitRemoteGlobal({ name }));
  }
  return normalizeGlobals(globals);
};
harden(makeEndoProvisionGlobals);
