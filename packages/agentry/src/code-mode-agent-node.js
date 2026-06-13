// @ts-check
/// <reference types="ses"/>

/* global globalThis */

/** @import { CodeModeRuntime, CodeModeRuntimeConfig, CodeModeAgentTemplate, CodeModeAgentPowers } from './code-mode-runtime.js' */

import {
  defineCodeModeAgent,
  normalizeCodeModeRuntimeConfig,
} from './code-mode-runtime.js';

/**
 * @returns {Record<string, string | undefined>}
 */
const getAmbientEnv = () =>
  /** @type {{ process?: { env?: Record<string, string | undefined> } }} */ (
    globalThis
  ).process?.env || {};

/**
 * @param {string | undefined} value
 * @returns {'readOnly' | 'readWrite' | undefined}
 */
const parseGitMode = value => {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (value === 'readOnly' || value === 'readonly' || value === 'read-only') {
    return 'readOnly';
  }
  if (
    value === 'readWrite' ||
    value === 'readwrite' ||
    value === 'read-write'
  ) {
    return 'readWrite';
  }
  throw new Error(`unsupported ENDO_CODE_MODE_GIT_MODE: ${value}`);
};

/**
 * Load the unconfined Endo-hosted code-mode configuration from an explicit
 * record or environment variables. Environment token values are represented as
 * an env-var name so the shared resolver controls when the secret is read.
 *
 * @param {object} [options]
 * @param {Partial<CodeModeRuntimeConfig>} [options.config]
 * @param {Record<string, string | undefined>} [options.env]
 * @returns {CodeModeRuntimeConfig}
 */
export const loadCodeModeConfig = (options = {}) => {
  if (options.config !== undefined) {
    return normalizeCodeModeRuntimeConfig(options.config);
  }
  const env = options.env || getAmbientEnv();
  return normalizeCodeModeRuntimeConfig({
    model: {
      provider: env.ENDO_CODE_MODE_PROVIDER,
      model: env.ENDO_CODE_MODE_MODEL || env.LAL_MODEL,
      baseUrl: env.ENDO_CODE_MODE_BASE_URL || env.LAL_HOST,
      apiTokenPetName: env.ENDO_CODE_MODE_API_TOKEN_PETNAME,
      apiTokenEnvVar:
        env.ENDO_CODE_MODE_API_TOKEN_ENV ||
        (env.ENDO_CODE_MODE_API_TOKEN
          ? 'ENDO_CODE_MODE_API_TOKEN'
          : undefined) ||
        (env.LAL_AUTH_TOKEN ? 'LAL_AUTH_TOKEN' : undefined),
    },
    powers: {
      workspacePetName: env.ENDO_CODE_MODE_WORKSPACE || 'workspace',
      gitPetName: env.ENDO_CODE_MODE_GIT || 'git',
      gitMode: parseGitMode(env.ENDO_CODE_MODE_GIT_MODE) || 'readWrite',
    },
    tools: { mode: 'executeOnly', include: ['workspace', 'git'] },
  });
};
harden(loadCodeModeConfig);

/**
 * @param {object} options
 * @param {CodeModeRuntime} options.runtime
 * @param {unknown} [options.context]
 */
export const makeCodeModeService = ({ runtime, context = undefined }) =>
  harden({
    /**
     * @param {string} text
     */
    async prompt(text) {
      if (typeof text !== 'string') {
        throw new Error('code-mode prompt text must be a string');
      }
      await runtime.agent.prompt(text);
      await runtime.agent.waitForIdle();
      return runtime.describe();
    },
    status() {
      return harden({
        ...runtime.describe(),
        contextPresent: context !== undefined && context !== null,
      });
    },
    /**
     * @param {string} [methodName]
     */
    help(methodName = undefined) {
      const methods = harden(['prompt', 'status', 'help']);
      if (methodName !== undefined && !methods.includes(methodName)) {
        throw new Error(`unknown code-mode service method: ${methodName}`);
      }
      if (methodName === 'prompt') {
        return 'prompt(text): run one Endo code-mode agent prompt';
      }
      if (methodName === 'status') {
        return 'status(): describe model, globals, tools, and Git authority';
      }
      if (methodName === 'help') {
        return 'help(methodName?): describe code-mode service methods';
      }
      return methods.join('\n');
    },
  });
harden(makeCodeModeService);

/**
 * Endo caplet entry point. This initial path may run unconfined for provider
 * SDK access, but repository authority still comes only from Endo powers.
 *
 * @param {unknown} powers
 * @param {unknown} context
 * @param {Omit<CodeModeAgentTemplate, 'config'> & Omit<CodeModeAgentPowers, 'powers' | 'env'> & {
 *   config?: Partial<CodeModeRuntimeConfig>,
 *   env?: Record<string, string | undefined>,
 * }} [options]
 */
export const make = async (powers, context, options = {}) => {
  const config = loadCodeModeConfig({
    config: options.config,
    env: options.env,
  });
  // Powerless first stage: define the agent from config (model, globals,
  // system prompt, tool schema). Powered second stage: grant `powers` and the
  // per-construction wiring to obtain the live runtime.
  const {
    config: _config,
    model,
    globals,
    systemPrompt,
    ...powerOptions
  } = options;
  const runtime = defineCodeModeAgent({
    config,
    model,
    globals,
    systemPrompt,
  }).make({
    ...powerOptions,
    powers,
  });
  return makeCodeModeService({ runtime, context });
};
harden(make);
