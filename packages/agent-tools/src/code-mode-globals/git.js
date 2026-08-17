// @ts-check
/// <reference types="ses"/>

/** @import { CodeModeGlobal } from '../code-mode/types.js' */

import { gitDeclarations } from '../../generated/code-mode-globals/git-declarations.js';

/**
 * The git exo's per-mode generated TypeScript declarations, keyed by code-mode
 * surface: ordinary read/write, history rewrite, and read-only inspection.
 * A consumer composing its own code-mode agent can read these directly to inject
 * git types into a hand-built global.
 */
export { gitDeclarations };

/**
 * Build the code-mode global descriptor for an `@endo/exo-git` Git capability.
 * The read-only vs read-write split is a prompt-surface choice: `readOnly`
 * selects the `gitReadOnly` declaration (inspection verbs only) and the
 * matching one-line description. Runtime read-only enforcement stays the exo
 * guard; this only governs which verbs the prompt advertises.
 *
 * @param {object} options
 * @param {string} options.name JS-identifier lexical binding name.
 * @param {string | string[]} [options.petName] Pet name to look the capability
 *   up by; defaults to `name`.
 * @param {boolean} [options.readOnly] Select the read-only prompt surface.
 * @param {boolean} [options.historyRewrite] Select the history-rewrite prompt
 *   surface.
 * @returns {CodeModeGlobal}
 */
export const makeGitGlobal = ({
  name,
  petName = name,
  readOnly = false,
  historyRewrite = false,
}) =>
  harden({
    name,
    petName,
    description: readOnly
      ? 'Read-only @endo/exo-git Git capability for repository inspection. In code mode, use status({ untracked: "normal" }) by default to collapse untracked directories; pass { untracked: "all" } when every untracked file is needed.'
      : historyRewrite
        ? 'History-rewrite @endo/exo-git Git capability for amend, reword, cherry-pick, and rebase. Rebase supports start, continue, abort, and skip; if start or continue stops for conflicts, resolve and stage them (checkoutConflict selects Git index stage 2 for ours or stage 3 for theirs, with branch roles inverted during rebase), then continue, skip, or abort.'
        : 'Read/write @endo/exo-git Git capability for repository changes. ' +
          'In code mode, use status({ untracked: "normal" }) by default to collapse untracked directories; pass { untracked: "all" } when every untracked file is needed. Stage a reported path with add([row.path]).',
    declaration: readOnly
      ? gitDeclarations.gitReadOnly
      : historyRewrite
        ? gitDeclarations.gitHistory
        : gitDeclarations.git,
  });
harden(makeGitGlobal);
