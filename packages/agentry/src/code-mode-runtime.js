// @ts-check
/// <reference types="ses"/>

/* global globalThis */

/** @import { Message, Model } from '@earendil-works/pi-ai' */
/** @import { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core' */
/** @import { ToolRecord } from '@endo/agent-tools' */
/** @import { LalCodeModeExecute, LalCodeModeGlobal } from './lal-code-mode.js' */

import { E } from '@endo/far';
import {
  getModel,
  registerBuiltInApiProviders,
} from '@earendil-works/pi-ai';
import { isGitReadOnly } from '@endo/exo-git';

import {
  makeLalCodeModeAgent,
  makeLalCodeModeExecuteTool,
  makeLalCodeModeSystemPrompt,
  normalizeLalCodeModeGlobals,
} from './lal-code-mode.js';

registerBuiltInApiProviders();

const DEFAULT_HOST = 'http://localhost:11434';
const DEFAULT_LOCAL_MODEL = 'qwen3';
/** @type {readonly ('workspace' | 'git')[]} */
const DEFAULT_TOOL_INCLUDE = harden(['workspace', 'git']);
const IDENTIFIER_RE = /^[A-Za-z_$][0-9A-Za-z_$]*$/;

/**
 * Runtime prompt/type declaration for the `@endo/endo-fs` Filesystem
 * capability supplied to the coding agent.
 *
 * @type {string}
 */
export const filesystemCapabilityType = `{
  root(): Promise<Directory>;
  named(name: string): Promise<Directory>;
  statfs(): Promise<object>;
  brands(): Promise<unknown[]>;
}

type Directory = {
  lookup(name: string): Promise<Directory | File>;
  list(): Promise<Cursor>;
  create(name: string, opts?: object): Promise<OpenFile>;
  makeDirectory(name: string, opts?: object): Promise<Directory>;
  remove(name: string): Promise<void>;
  getStat(): Promise<{ size?: bigint; mtime?: bigint; atime?: bigint }>;
  setStat(patch: { size?: bigint; mtime?: bigint; atime?: bigint }): Promise<void>;
  materialise(path: string[], opts?: object): Promise<Directory>;
};

type File = {
  open(opts?: { read?: boolean; write?: boolean; create?: boolean; truncate?: boolean }): Promise<OpenFile>;
  getStat(): Promise<{ size?: bigint; mtime?: bigint; atime?: bigint }>;
  setStat(patch: { size?: bigint; mtime?: bigint; atime?: bigint }): Promise<void>;
  snapshot(): Promise<object>;
};

type Cursor = {
  read(limit?: bigint): Promise<{ entries: Array<{ name: string; kind: 'file' | 'directory' }>; atEnd: boolean }>;
  toArray(): Promise<Array<{ name: string; kind: 'file' | 'directory' }>>;
};

type OpenFile = {
  read(offset?: bigint, length?: bigint): Promise<PassableBytesReader>;
  write(offset?: bigint): Promise<PassableBytesWriter>;
  truncate(size: bigint): Promise<void>;
  close(): Promise<void>;
};`;
harden(filesystemCapabilityType);

/**
 * Runtime prompt/type declaration for the read-only Git capability supplied as
 * a lexical code-mode global. This is broader than the JSON-safe
 * `@endo/agent-tools` Git tool catalog because code-mode receives a live Endo
 * capability in its Compartment.
 *
 * @type {string}
 */
export const gitReadOnlyCodeModeCapabilityType = `{
  status(): Promise<Array<{ entry: object; path: string; index: 'clean' | 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'conflicted'; worktree: 'clean' | 'modified' | 'deleted' | 'untracked' | 'ignored' | 'conflicted'; node?: object; renamedFrom?: string }>>;
  log(options?: { maxCount?: number; ref?: string | object; since?: string; until?: string }): Promise<Array<{ oid: string; summary: string; author?: string; committedAt?: number }>>;
  diff(options?: { cached?: boolean; base?: string | object; head?: string | object; entries?: object[]; paths?: string[] }): Promise<string>;
  show(ref: string | object): Promise<string>;
  filesystemAt(ref: string | object): Promise<Filesystem>;
  branches(): Promise<Array<{ name: string; kind: 'branch' | 'tag' | 'commit' | 'detached'; oid?: string }>>;
  currentBranch(): Promise<{ name: string; kind: 'branch' | 'tag' | 'commit' | 'detached'; oid?: string } | undefined>;
}`;
harden(gitReadOnlyCodeModeCapabilityType);

/**
 * Runtime prompt/type declaration for the writable Git capability supplied as
 * a lexical code-mode global.
 *
 * @type {string}
 */
export const gitWritableCodeModeCapabilityType = `{
  status(): Promise<Array<{ entry: object; path: string; index: 'clean' | 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'conflicted'; worktree: 'clean' | 'modified' | 'deleted' | 'untracked' | 'ignored' | 'conflicted'; node?: object; renamedFrom?: string }>>;
  log(options?: { maxCount?: number; ref?: string | object; since?: string; until?: string }): Promise<Array<{ oid: string; summary: string; author?: string; committedAt?: number }>>;
  diff(options?: { cached?: boolean; base?: string | object; head?: string | object; entries?: object[]; paths?: string[] }): Promise<string>;
  show(ref: string | object): Promise<string>;
  filesystemAt(ref: string | object): Promise<Filesystem>;
  branches(): Promise<Array<{ name: string; kind: 'branch' | 'tag' | 'commit' | 'detached'; oid?: string }>>;
  currentBranch(): Promise<{ name: string; kind: 'branch' | 'tag' | 'commit' | 'detached'; oid?: string } | undefined>;
  add(entries: object[]): Promise<void>;
  restore(entries: object[], options?: { staged?: boolean }): Promise<void>;
  commit(message: string): Promise<{ oid: string; summary: string; author?: string; committedAt?: number }>;
  createBranch(name: string, options?: { startPoint?: string; switchAfterCreate?: boolean }): Promise<{ name: string; kind: 'branch' | 'tag' | 'commit' | 'detached'; oid?: string }>;
  switchBranch(name: string): Promise<void>;
}`;
harden(gitWritableCodeModeCapabilityType);

/**
 * Runtime prompt/type declaration for a policy-gated GitRemote capability.
 * GitRemote authority is intentionally supplied as an explicit named power,
 * not as part of the default Git power.
 *
 * @type {string}
 */
export const gitRemoteCodeModeCapabilityType = `{
  inspect(): Promise<object>;
  fetch(options?: { prune?: boolean; tags?: boolean }): Promise<object>;
  pull(options?: { branch?: string | object; strategy?: 'merge' | 'rebase' | 'ff-only'; prune?: boolean; tags?: boolean }): Promise<object>;
  push(options?: { source?: string | object; destination?: string | object; setUpstream?: boolean }): Promise<object>;
}`;
harden(gitRemoteCodeModeCapabilityType);

/**
 * @typedef {object} CodeModeModelConfig
 * @property {string} [provider]
 * @property {string} [model]
 * @property {string} [baseUrl]
 * @property {'openai-completions' | string} [api]
 * @property {boolean} [reasoning]
 * @property {string | string[]} [apiTokenPetName]
 * @property {string} [apiTokenEnvVar]
 *
 * @typedef {object} CodeModePowerConfig
 * @property {unknown} [workspace]
 * @property {string} [workspacePetName]
 * @property {unknown} [git]
 * @property {string} [gitPetName]
 * @property {'readOnly' | 'readWrite'} [gitMode]
 * @property {LalCodeModeGlobal[]} [namedPowers]
 *
 * @typedef {object} CodeModeToolConfig
 * @property {'executeOnly'} [mode]
 * @property {readonly ('workspace' | 'git')[]} [include]
 *
 * @typedef {object} CodeModeRuntimeConfig
 * @property {CodeModeModelConfig} model
 * @property {CodeModePowerConfig} powers
 * @property {CodeModeToolConfig} [tools]
 * @property {{ persist?: boolean, petName?: string | string[] }} [transcript]
 *
 * @typedef {object} CodeModeRuntime
 * @property {import('@earendil-works/pi-agent-core').Agent} agent
 * @property {Model<string>} model
 * @property {(provider: string) => Promise<string | undefined> | string | undefined} getApiKey
 * @property {LalCodeModeGlobal[]} globals
 * @property {LalCodeModeExecute} execute
 * @property {string} systemPrompt
 * @property {ToolRecord} tool
 * @property {CodeModeRuntimeConfig} config
 * @property {() => object} describe
 */

/**
 * @param {unknown} value
 * @returns {value is string | string[]}
 */
const isPetName = value =>
  typeof value === 'string' ||
  (Array.isArray(value) && value.every(part => typeof part === 'string'));

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
const nonEmptyString = value =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * @returns {Record<string, string | undefined>}
 */
const getAmbientEnv = () =>
  /** @type {{ process?: { env?: Record<string, string | undefined> } }} */ (
    globalThis
  ).process?.env || {};

/**
 * @param {string} value
 * @returns {string}
 */
const trimTrailingSlashes = value => value.replace(/\/+$/, '');

/**
 * @param {string} baseUrl
 * @returns {string}
 */
const normalizeOpenAIBaseUrl = baseUrl => {
  const trimmed = trimTrailingSlashes(baseUrl);
  return trimmed.match(/\/v1(?:\/.*)?$/) ? trimmed : `${trimmed}/v1`;
};

/**
 * @param {string | string[] | undefined} petName
 * @param {string} fallback
 * @returns {string | string[]}
 */
const normalizePetName = (petName, fallback) => {
  const value = petName ?? fallback;
  if (!isPetName(value)) {
    throw new Error(`invalid pet name for ${fallback}`);
  }
  return value;
};

/**
 * @param {readonly unknown[] | undefined} include
 * @returns {readonly ('workspace' | 'git')[]}
 */
const normalizeToolInclude = include => {
  if (include === undefined) {
    return DEFAULT_TOOL_INCLUDE;
  }
  const seen = new Set();
  /** @type {('workspace' | 'git')[]} */
  const normalized = [];
  for (const value of include) {
    if (value !== 'workspace' && value !== 'git') {
      throw new Error(`unsupported code-mode tool include: ${String(value)}`);
    }
    if (!seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  }
  return harden(normalized);
};

/**
 * @param {string} petName
 * @param {string} label
 * @returns {string}
 */
const petNameToBindingName = (petName, label) => {
  if (IDENTIFIER_RE.test(petName)) {
    return petName;
  }
  throw new Error(
    `code-mode ${label} petName must be a single JS identifier to use as a lexical binding`,
  );
};

/**
 * @param {string | string[] | undefined} petName
 * @param {string} fallback
 * @returns {string}
 */
const normalizeBindingPetName = (petName, fallback) => {
  const value = normalizePetName(petName, fallback);
  if (typeof value !== 'string') {
    throw new Error(
      `code-mode ${fallback} petName must be a single JS identifier to use as a lexical binding`,
    );
  }
  return petNameToBindingName(value, fallback);
};

/**
 * @param {Partial<CodeModeRuntimeConfig> | undefined} config
 * @returns {CodeModeRuntimeConfig}
 */
export const normalizeCodeModeRuntimeConfig = (config = {}) => {
  const model = harden({ ...(config.model || {}) });
  const rawPowers = config.powers || {};
  const gitMode = rawPowers.gitMode || 'readWrite';
  if (gitMode !== 'readOnly' && gitMode !== 'readWrite') {
    throw new Error(`unsupported code-mode gitMode: ${String(gitMode)}`);
  }

  const tools = harden({
    mode: config.tools?.mode || 'executeOnly',
    include: normalizeToolInclude(config.tools?.include),
  });
  if (tools.mode !== 'executeOnly') {
    throw new Error(`unsupported code-mode tool mode: ${String(tools.mode)}`);
  }

  const powers = harden({
    workspace: rawPowers.workspace,
    workspacePetName: normalizeBindingPetName(
      rawPowers.workspacePetName,
      'workspace',
    ),
    git: rawPowers.git,
    gitPetName: normalizeBindingPetName(rawPowers.gitPetName, 'git'),
    gitMode,
    namedPowers: normalizeLalCodeModeGlobals(rawPowers.namedPowers || []),
  });

  return harden({
    model,
    powers,
    tools,
    transcript: config.transcript && harden({ ...config.transcript }),
  });
};
harden(normalizeCodeModeRuntimeConfig);

/**
 * @param {string} id
 * @param {string} baseUrl
 * @param {string} provider
 * @param {string} namePrefix
 * @param {string} api
 * @param {boolean | undefined} reasoning
 * @returns {Model<string>}
 */
const buildOpenAICompatibleModel = (
  id,
  baseUrl,
  provider,
  namePrefix,
  api,
  reasoning,
) =>
  harden({
    id,
    name: `${namePrefix}/${id}`,
    api,
    provider,
    baseUrl,
    reasoning: reasoning === true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 8192,
  });

/**
 * @param {CodeModeModelConfig} modelConfig
 * @returns {{ model: Model<string>, localOllama: boolean }}
 */
export const resolveCodeModeModelConfig = (modelConfig = {}) => {
  const api = modelConfig.api || 'openai-completions';
  const modelName = modelConfig.model || DEFAULT_LOCAL_MODEL;
  const parsed =
    modelConfig.provider === undefined && modelName.includes('/')
      ? {
          provider: modelName.slice(0, modelName.indexOf('/')),
          model: modelName.slice(modelName.indexOf('/') + 1),
        }
      : undefined;
  const provider = modelConfig.provider || parsed?.provider;
  const id = parsed?.model || modelName;
  const baseUrl = modelConfig.baseUrl;

  if (
    provider !== undefined &&
    provider !== 'ollama' &&
    provider !== 'openai-compatible' &&
    baseUrl === undefined
  ) {
    // @ts-expect-error - permissive runtime lookup against KnownProvider overloads
    const registryModel = getModel(provider, id);
    if (registryModel === undefined) {
      throw new Error(`Unknown pi-ai model: ${provider}/${id}`);
    }
    return harden({ model: registryModel, localOllama: false });
  }

  const localOllama =
    provider === 'ollama' ||
    (provider === undefined &&
      (baseUrl === undefined || baseUrl.includes('localhost:11434')));
  const endpoint = localOllama
    ? normalizeOpenAIBaseUrl(baseUrl || DEFAULT_HOST)
    : normalizeOpenAIBaseUrl(
        baseUrl ||
          (() => {
            throw new Error(
              'code-mode openai-compatible model config requires baseUrl',
            );
          })(),
      );

  return harden({
    model: buildOpenAICompatibleModel(
      id,
      endpoint,
      'openai',
      localOllama ? 'ollama' : 'openai-compatible',
      api,
      modelConfig.reasoning,
    ),
    localOllama,
  });
};
harden(resolveCodeModeModelConfig);

/**
 * @param {unknown} value
 * @returns {Promise<string>}
 */
const coerceToken = async value => {
  const token = await value;
  if (typeof token !== 'string') {
    throw new Error('code-mode API token capability did not resolve to string');
  }
  return token;
};

/**
 * @param {object} options
 * @param {CodeModeModelConfig} options.modelConfig
 * @param {unknown} [options.powers]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {(provider: string) => Promise<string | undefined> | string | undefined} [options.getApiKey]
 * @param {boolean} [options.localOllama]
 * @returns {(provider: string) => Promise<string | undefined>}
 */
export const makeCodeModeApiKeyResolver = ({
  modelConfig,
  powers,
  env = getAmbientEnv(),
  getApiKey,
  localOllama = false,
}) => {
  const { apiTokenPetName, apiTokenEnvVar } = modelConfig;
  return async provider => {
    const callbackToken = await getApiKey?.(provider);
    if (callbackToken !== undefined) {
      return callbackToken;
    }
    if (apiTokenPetName !== undefined) {
      if (!isPetName(apiTokenPetName)) {
        throw new Error('code-mode apiTokenPetName must be a string or path');
      }
      if (powers === undefined) {
        throw new Error(
          'code-mode apiTokenPetName requires powers with lookup',
        );
      }
      return coerceToken(
        E(
          /** @type {{ lookup: (petName: string | string[]) => Promise<unknown> }} */ (
            powers
          ),
        ).lookup(apiTokenPetName),
      );
    }
    const envToken = nonEmptyString(
      apiTokenEnvVar === undefined ? undefined : env[apiTokenEnvVar],
    );
    if (envToken !== undefined) {
      return envToken;
    }
    if (localOllama) {
      return nonEmptyString(env.OLLAMA_API_KEY) || 'ollama';
    }
    return undefined;
  };
};
harden(makeCodeModeApiKeyResolver);

/**
 * @param {unknown} powers
 * @param {string | string[]} petName
 * @param {string} label
 * @returns {unknown}
 */
const lookupRequiredPower = (powers, petName, label) => {
  if (powers === undefined || powers === null) {
    throw new Error(`code-mode ${label} capability requires powers`);
  }
  return E(
    /** @type {{ lookup: (petName: string | string[]) => Promise<unknown> }} */ (
      powers
    ),
  ).lookup(petName);
};

/**
 * @param {CodeModeRuntimeConfig} config
 * @param {unknown} powers
 * @returns {Record<string, unknown>}
 */
const resolveConfiguredPowers = (config, powers) => {
  const include = config.tools?.include || DEFAULT_TOOL_INCLUDE;
  /** @type {Record<string, unknown>} */
  const resolved = {};
  if (include.includes('workspace')) {
    const workspacePetName = config.powers.workspacePetName ?? 'workspace';
    const workspaceName = petNameToBindingName(workspacePetName, 'workspace');
    resolved[workspaceName] =
      config.powers.workspace ??
      lookupRequiredPower(powers, workspacePetName, 'workspace');
  }
  if (include.includes('git')) {
    const gitPetName = config.powers.gitPetName ?? 'git';
    const gitName = petNameToBindingName(gitPetName, 'git');
    resolved[gitName] =
      config.powers.git ?? lookupRequiredPower(powers, gitPetName, 'git');
    if (config.powers.gitMode === 'readOnly') {
      const gitReadOnly = isGitReadOnly(resolved[gitName]);
      if (gitReadOnly === false) {
        throw new Error(
          'code-mode gitMode readOnly requires an already read-only Git capability',
        );
      }
    }
  }
  return harden(resolved);
};

/**
 * @param {CodeModeRuntimeConfig} config
 * @returns {LalCodeModeGlobal[]}
 */
export const makeCodeModeGlobals = config => {
  const include = config.tools?.include || DEFAULT_TOOL_INCLUDE;
  /** @type {LalCodeModeGlobal[]} */
  const globals = [];
  if (include.includes('workspace')) {
    const workspacePetName = config.powers.workspacePetName ?? 'workspace';
    globals.push({
      name: petNameToBindingName(workspacePetName, 'workspace'),
      petName: workspacePetName,
      type: filesystemCapabilityType,
      description: 'Writable @endo/endo-fs Filesystem for the repository.',
    });
  }
  if (include.includes('git')) {
    const readOnlyGit = config.powers.gitMode === 'readOnly';
    const gitPetName = config.powers.gitPetName ?? 'git';
    globals.push({
      name: petNameToBindingName(gitPetName, 'git'),
      petName: gitPetName,
      type: readOnlyGit
        ? gitReadOnlyCodeModeCapabilityType
        : gitWritableCodeModeCapabilityType,
      description: readOnlyGit
        ? 'Read-only @endo/exo-git Git capability for repository inspection.'
        : 'Read/write @endo/exo-git Git capability for repository changes.',
    });
  }
  globals.push(...(config.powers.namedPowers || []));
  return normalizeLalCodeModeGlobals(globals);
};
harden(makeCodeModeGlobals);

/**
 * @param {CodeModeRuntimeConfig} config
 * @param {Record<string, unknown>} resolvedPowers
 * @param {Record<string, unknown>} baseEndowments
 * @param {unknown} powers
 * @returns {Record<string, unknown>}
 */
const makeCodeModeEndowments = (
  config,
  resolvedPowers,
  baseEndowments,
  powers,
) => {
  /** @type {Record<string, unknown>} */
  const endowments = {
    E,
    ...baseEndowments,
    ...resolvedPowers,
  };
  for (const namedPower of config.powers.namedPowers || []) {
    if (!Object.prototype.hasOwnProperty.call(endowments, namedPower.name)) {
      endowments[namedPower.name] = lookupRequiredPower(
        powers,
        namedPower.petName || namedPower.name,
        namedPower.name,
      );
    }
  }
  return harden(endowments);
};

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
export const makeCodeModeCompartmentExecute = ({
  endowments,
  storeResult,
}) => {
  const hardenedEndowments = harden({ ...endowments });
  return async ({ source, resultName }) => {
    const compartment = new Compartment(hardenedEndowments);
    const result = await compartment.evaluate(source);
    if (resultName !== undefined) {
      if (storeResult === undefined) {
        throw new Error(
          'execute.resultName was supplied but no storeResult callback is configured',
        );
      }
      await storeResult(result, resultName);
    }
    return result;
  };
};
harden(makeCodeModeCompartmentExecute);

/**
 * @param {object} options
 * @param {Partial<CodeModeRuntimeConfig>} [options.config]
 * @param {unknown} [options.powers]
 * @param {Record<string, unknown>} [options.endowments]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {Model<string>} [options.model]
 * @param {(provider: string) => Promise<string | undefined> | string | undefined} [options.getApiKey]
 * @param {LalCodeModeExecute} [options.execute]
 * @param {(value: unknown, resultName: string | string[]) => Promise<void> | void} [options.storeResult]
 * @param {LalCodeModeGlobal[]} [options.globals]
 * @param {string} [options.systemPrompt]
 * @param {AgentMessage[]} [options.messages]
 * @param {StreamFn} [options.streamFn]
 * @param {(messages: AgentMessage[]) => Message[] | Promise<Message[]>} [options.convertToLlm]
 * @param {'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'} [options.thinkingLevel]
 * @returns {CodeModeRuntime}
 */
export const makeCodeModeRuntime = options => {
  const config = normalizeCodeModeRuntimeConfig(options.config);
  const resolvedModel =
    options.model === undefined
      ? resolveCodeModeModelConfig(config.model)
      : harden({ model: options.model, localOllama: false });
  const getApiKey = makeCodeModeApiKeyResolver({
    modelConfig: config.model,
    powers: options.powers,
    env: options.env,
    getApiKey: options.getApiKey,
    localOllama: resolvedModel.localOllama,
  });
  const resolvedPowers = resolveConfiguredPowers(config, options.powers);
  const globals =
    options.globals === undefined
      ? makeCodeModeGlobals(config)
      : normalizeLalCodeModeGlobals(options.globals);
  const execute =
    options.execute ||
    makeCodeModeCompartmentExecute({
      endowments: makeCodeModeEndowments(
        config,
        resolvedPowers,
        options.endowments || {},
        options.powers,
      ),
      storeResult: options.storeResult,
    });
  const systemPrompt =
    options.systemPrompt || makeLalCodeModeSystemPrompt(globals);
  const tool = makeLalCodeModeExecuteTool(execute, globals);
  const agent = makeLalCodeModeAgent({
    model: resolvedModel.model,
    globals,
    execute,
    systemPrompt,
    messages: options.messages,
    streamFn: options.streamFn,
    convertToLlm: options.convertToLlm,
    getApiKey,
    thinkingLevel: options.thinkingLevel,
  });
  return {
    agent,
    model: resolvedModel.model,
    getApiKey,
    globals,
    execute,
    systemPrompt,
    tool,
    config,
    describe: () =>
      harden({
        model: {
          provider: resolvedModel.model.provider,
          id: resolvedModel.model.id,
          api: resolvedModel.model.api,
          reasoning: resolvedModel.model.reasoning,
        },
        tools: harden(agent.state.tools.map(agentTool => agentTool.name)),
        globals: harden(
          globals.map(global =>
            harden({
              name: global.name,
              petName: global.petName,
              type: global.type,
              description: global.description,
            }),
          ),
        ),
        gitMode: config.powers.gitMode,
        transcript: config.transcript,
      }),
  };
};
harden(makeCodeModeRuntime);

/**
 * @param {Parameters<typeof makeCodeModeRuntime>[0]} options
 * @returns {import('@earendil-works/pi-agent-core').Agent}
 */
export const makeCodeModeAgent = options =>
  makeCodeModeRuntime(options).agent;
harden(makeCodeModeAgent);
