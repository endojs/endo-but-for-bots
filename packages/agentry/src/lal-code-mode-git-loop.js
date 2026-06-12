// @ts-check
/// <reference types="ses"/>

/** @import { Message, Model } from '@earendil-works/pi-ai' */
/** @import { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core' */
/** @import { LalCodeModeExecute, LalCodeModeGlobal } from './lal-code-mode.js' */

import { makeLalCodeModeSystemPrompt } from './lal-code-mode.js';
import {
  filesystemCapabilityType,
  gitReadOnlyCodeModeCapabilityType,
  gitWritableCodeModeCapabilityType,
  makeCodeModeCompartmentExecute,
  makeCodeModeRuntime,
} from './code-mode-runtime.js';

export { filesystemCapabilityType };

/**
 * @typedef {object} LalCodeModeGitLoopGlobalOptions
 * @property {string} [workspaceName]
 * @property {string | string[]} [workspacePetName]
 * @property {string} [gitName]
 * @property {string | string[]} [gitPetName]
 * @property {boolean} [readOnlyGit]
 */

/**
 * @param {LalCodeModeGitLoopGlobalOptions} [options]
 * @returns {LalCodeModeGlobal[]}
 */
export const makeLalCodeModeGitLoopGlobals = (options = {}) => {
  const {
    workspaceName = 'workspace',
    workspacePetName = workspaceName,
    gitName = 'git',
    gitPetName = gitName,
    readOnlyGit = false,
  } = options;
  return harden([
    {
      name: workspaceName,
      petName: workspacePetName,
      type: filesystemCapabilityType,
      description: 'Writable @endo/endo-fs Filesystem for the repository.',
    },
    {
      name: gitName,
      petName: gitPetName,
      type: readOnlyGit
        ? gitReadOnlyCodeModeCapabilityType
        : gitWritableCodeModeCapabilityType,
      description: readOnlyGit
        ? 'Read-only @endo/exo-git Git capability for repository inspection.'
        : 'Read/write @endo/exo-git Git capability for repository changes.',
    },
  ]);
};
harden(makeLalCodeModeGitLoopGlobals);

/**
 * @param {LalCodeModeGlobal[]} globals
 * @param {{ preamble?: string }} [options]
 * @returns {string}
 */
export const makeLalCodeModeGitLoopSystemPrompt = (
  globals = makeLalCodeModeGitLoopGlobals(),
  options = {},
) =>
  makeLalCodeModeSystemPrompt(globals, {
    preamble:
      options.preamble ||
      'You are an Endo-hosted Pi coding agent. Use the execute tool to inspect and edit the repository through the workspace Filesystem and Git capabilities.',
  });
harden(makeLalCodeModeGitLoopSystemPrompt);

/**
 * Build a simple Compartment-backed execute function. Callers supply all
 * endowments they want in lexical scope, typically `{ E, workspace, git }`
 * plus stream helpers such as `TextEncoder` or `iterateBytesWriter`.
 *
 * @param {object} options
 * @param {Record<string, unknown>} options.endowments
 * @param {(value: unknown, resultName: string | string[]) => Promise<void> | void} [options.storeResult]
 * @returns {LalCodeModeExecute}
 */
export const makeLalCodeModeCompartmentExecute =
  makeCodeModeCompartmentExecute;
harden(makeLalCodeModeCompartmentExecute);

/**
 * Construct the execute-only Pi coding agent for a repository loop.
 *
 * @param {object} options
 * @param {Model<string>} options.model
 * @param {unknown} options.workspace
 * @param {unknown} options.git
 * @param {LalCodeModeExecute} [options.execute]
 * @param {Record<string, unknown>} [options.endowments]
 * @param {LalCodeModeGlobal[]} [options.globals]
 * @param {string} [options.systemPrompt]
 * @param {AgentMessage[]} [options.messages]
 * @param {StreamFn} [options.streamFn]
 * @param {(messages: AgentMessage[]) => Message[] | Promise<Message[]>} [options.convertToLlm]
 * @param {(provider: string) => Promise<string | undefined> | string | undefined} [options.getApiKey]
 * @param {'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'} [options.thinkingLevel]
 * @param {boolean} [options.readOnlyGit]
 * @returns {import('@earendil-works/pi-agent-core').Agent}
 */
export const makeLalCodeModeGitLoopAgent = options => {
  const {
    model,
    workspace,
    git,
    globals = makeLalCodeModeGitLoopGlobals({
      readOnlyGit: options.readOnlyGit,
    }),
    systemPrompt = makeLalCodeModeGitLoopSystemPrompt(globals),
    execute,
    messages,
    streamFn,
    convertToLlm,
    getApiKey,
    thinkingLevel,
  } = options;

  return makeCodeModeRuntime({
    config: harden({
      model: harden({}),
      powers: harden({
        workspace,
        git,
        gitMode: options.readOnlyGit ? 'readOnly' : 'readWrite',
      }),
      tools: harden({ mode: 'executeOnly', include: harden(['workspace', 'git']) }),
    }),
    model,
    endowments: options.endowments,
    globals,
    execute,
    systemPrompt,
    messages,
    streamFn,
    convertToLlm,
    getApiKey,
    thinkingLevel,
  }).agent;
};
harden(makeLalCodeModeGitLoopAgent);
