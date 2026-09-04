// @ts-check
/// <reference types="ses"/>

/** @import { ERef } from '@endo/eventual-send' */
/** @import { Filesystem } from '@endo/platform/fs/extended' */
/** @import { EvalCondition } from '../types.js' */
/** @import { GitHistoryToolCapability, GitMountToolCapability, GitToolCapability } from '@endo/agent-tools' */

import {
  makeGitMountTools,
  makeGitHistoryTool,
  makeGitTool,
  makeMountFsTools,
} from '@endo/agent-tools';
import { toPiAgentTool } from '@endo/agent-tools/pi';

import { makePiAgent } from '../../harness/pi-agent.js';

export const makeToolCallsSystemPrompt =
  () => `You are an Endo eval coding agent.
Use the provided tools to inspect, edit, stage, and commit the repository.

Use repo-relative paths.
Prefer the git tools for repository state and commits.
Prefer the mount tools for file reads, writes, and directory listings.
Do not answer in prose when a tool call can complete the task.`;
harden(makeToolCallsSystemPrompt);

/**
 * Tool-call condition: direct pi-agent tool calls over the same live workspace
 * and git capabilities the code-mode condition receives.
 *
 * @type {EvalCondition}
 */
export const toolCallsCondition = harden({
  name: 'tool-calls',
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
    const workspaceCap = /** @type {ERef<Filesystem>} */ (workspace);
    const gitCap =
      /** @type {ERef<GitToolCapability & GitMountToolCapability>} */ (git);
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
    ]).map(tool => toPiAgentTool(tool));
    return makePiAgent({
      model,
      tools,
      systemPrompt: makeToolCallsSystemPrompt(),
      getApiKey,
      thinkingLevel,
      streamFn,
    });
  },
});
harden(toolCallsCondition);
