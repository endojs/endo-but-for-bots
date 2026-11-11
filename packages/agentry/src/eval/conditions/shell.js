// @ts-check
/// <reference types="ses"/>

/** @import { ERef } from '@endo/eventual-send' */
/** @import { Filesystem } from '@endo/platform/fs/extended' */
/** @import { EvalCondition } from '../types.js' */
/** @import { GitHistoryToolCapability, GitMountToolCapability, GitToolCapability, ShellToolCapability } from '@endo/agent-tools' */

import {
  makeGitHistoryTool,
  makeGitMountTools,
  makeGitTool,
  makeMountFsTools,
  makeShellTool,
} from '@endo/agent-tools';
import { toPiAgentTool } from '@endo/agent-tools/pi';

import { makePiAgent } from '../../harness/pi-agent.js';

export const makeShellSystemPrompt = () => `You are an Endo eval coding agent.
Use the provided repository tools to inspect, edit, stage, and commit the repository.

The shell is scenario-scoped and allowlisted; use it only for the listed command
and keep all paths repository-relative.
Prefer the Git and mount tools for repository changes and file edits.
Do not answer in prose when a tool call can complete the task.`;
harden(makeShellSystemPrompt);

/**
 * Shell-backed matrix condition. The shell is an additional capability with
 * explicit timeout, output, environment, and command bounds; Git and mount
 * tools remain available so history authority is selected from the scenario
 * requirement rather than inferred from the condition name.
 *
 * @type {EvalCondition}
 */
export const shellCondition = harden({
  name: 'shell',
  makeAgent: options => {
    const {
      model,
      workspace,
      git,
      shell,
      scenario,
      getApiKey,
      thinkingLevel,
      streamFn,
    } = options;
    if (shell === undefined) {
      throw new Error(
        'shell condition requires a provisioned Shell capability',
      );
    }
    const workspaceCap = /** @type {ERef<Filesystem>} */ (workspace);
    const gitCap =
      /** @type {ERef<GitToolCapability & GitMountToolCapability>} */ (git);
    const shellCap = /** @type {ERef<ShellToolCapability>} */ (shell);
    const gitTools =
      scenario.requirements?.allowHistoryRewrite === true
        ? makeGitHistoryTool(
            /** @type {ERef<GitHistoryToolCapability>} */ (git),
          )
        : makeGitTool(gitCap);
    const tools = harden([
      ...gitTools,
      ...makeGitMountTools(gitCap),
      ...makeMountFsTools(workspaceCap),
      ...makeShellTool(shellCap),
    ]).map(tool => toPiAgentTool(tool));
    return makePiAgent({
      model,
      tools,
      systemPrompt: makeShellSystemPrompt(),
      getApiKey,
      thinkingLevel,
      streamFn,
    });
  },
});
harden(shellCondition);
