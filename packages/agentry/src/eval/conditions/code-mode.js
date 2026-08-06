// @ts-check
/// <reference types="ses"/>

/** @import { EvalCondition } from '../types.js' */

import { makeCodeModeGitLoopAgent } from '../../code-mode.js';

/**
 * Existing code-mode eval condition: one `execute` tool evaluates JavaScript
 * against the live workspace and git powers.
 *
 * @type {EvalCondition}
 */
export const codeModeCondition = harden({
  name: 'code-mode',
  makeAgent: options => {
    const {
      model,
      workspace,
      git,
      scenario,
      getApiKey,
      thinkingLevel,
      streamFn,
    } = options;
    return makeCodeModeGitLoopAgent({
      model,
      workspace,
      git,
      historyRewriteGit: scenario.requirements?.allowHistoryRewrite === true,
      getApiKey,
      thinkingLevel,
      streamFn,
    });
  },
});
harden(codeModeCondition);
