// @ts-check
/// <reference types="ses"/>

/** @import { CodeModeGlobal } from '@endo/agent-tools/code-mode/types.js' */
/** @import { EndoCodeModeProvisionPersistence } from './code-mode-provisioning-types.js' */

import { makeWorkspaceGlobal } from '@endo/agent-tools/code-mode-globals/fs.js';
import { makeGitGlobal } from '@endo/agent-tools/code-mode-globals/git.js';
import { normalizeGlobals } from '@endo/agent-tools/code-mode/declarations.js';

/**
 * Derive inert lexical descriptors directly from the validated provisioning
 * policy.
 * The daemon guest remains the authority-bearing evaluator backend; this
 * function never looks up or wraps a guest capability.
 *
 * @param {EndoCodeModeProvisionPersistence} persistence
 * @returns {CodeModeGlobal[]}
 */
export const makeEndoProvisionGlobals = persistence => {
  const { authority, introducedNames, internalGit } = persistence;
  /** @type {CodeModeGlobal[]} */
  const globals = [];
  for (const [name, mount] of Object.entries(authority.mount ?? {})) {
    globals.push(
      makeWorkspaceGlobal({
        name,
        readOnly: mount.readOnly ?? false,
      }),
    );
  }
  for (const [name, grant] of Object.entries(authority.git ?? {})) {
    globals.push(
      makeGitGlobal({
        name,
        readOnly: grant.readOnly ?? false,
        historyRewrite: grant.allowHistoryRewrite ?? false,
      }),
    );
  }
  for (const name of Object.keys(authority.gitRemote ?? {})) {
    globals.push({ name });
  }
  for (const [hostName, guestName] of Object.entries(introducedNames)) {
    if (hostName !== internalGit?.gitName) {
      globals.push({ name: guestName });
    }
  }
  if (internalGit !== undefined) {
    globals.push(makeGitGlobal({ name: 'git', readOnly: true }));
  }
  return normalizeGlobals(globals);
};
harden(makeEndoProvisionGlobals);
