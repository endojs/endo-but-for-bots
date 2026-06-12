// @ts-check
/// <reference types="ses"/>

/** @import { ToolRecord } from '@endo/agent-tools' */
/** @import { CodeModeRuntime, CodeModeRuntimeConfig } from './code-mode-runtime.js' */

import { E } from '@endo/far';
import { makeTool } from '@endo/agent-tools/tool.js';

import {
  makeCodeModeRuntime,
  normalizeCodeModeRuntimeConfig,
} from './code-mode-runtime.js';

const BINDING_PET_NAME_SCHEMA = harden({ type: 'string' });
const PET_NAME_SCHEMA = harden({
  anyOf: [
    { type: 'string' },
    { type: 'array', items: { type: 'string' } },
  ],
});

const DELEGATE_PARAMETERS = harden({
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: 'Prompt for the delegated Endo code-mode agent.',
    },
    powers: {
      type: 'object',
      properties: {
        workspace: BINDING_PET_NAME_SCHEMA,
        git: BINDING_PET_NAME_SCHEMA,
        gitMode: { enum: ['readOnly', 'readWrite'] },
      },
      required: [],
      additionalProperties: PET_NAME_SCHEMA,
    },
    modelProfile: {
      ...PET_NAME_SCHEMA,
      description:
        'Pet name for a caller-held model profile to use for the delegated agent.',
    },
  },
  required: ['prompt'],
  additionalProperties: false,
});

const RESERVED_POWER_NAMES = harden(new Set(['workspace', 'git', 'gitMode']));

/**
 * @param {unknown} value
 * @returns {value is string | string[]}
 */
const isPetName = value =>
  typeof value === 'string' ||
  (Array.isArray(value) && value.every(part => typeof part === 'string'));

/**
 * @param {unknown} value
 * @returns {value is string}
 */
const isBindingPetName = value => typeof value === 'string';

/**
 * @param {string | string[]} a
 * @param {string | string[]} b
 * @returns {boolean}
 */
const petNamesEqual = (a, b) => {
  if (typeof a === 'string' || typeof b === 'string') {
    return a === b;
  }
  return a.length === b.length && a.every((part, index) => part === b[index]);
};

/**
 * @param {CodeModeRuntimeConfig} config
 * @returns {Map<string, import('./lal-code-mode.js').LalCodeModeGlobal>}
 */
const makeNamedPowerCatalog = config =>
  new Map((config.powers.namedPowers || []).map(power => [power.name, power]));

/**
 * @param {unknown} powers
 * @param {string | string[]} petName
 * @param {string} label
 * @returns {Promise<unknown>}
 */
const lookupDelegatedPower = async (powers, petName, label) => {
  if (powers === undefined || powers === null) {
    throw new Error(`delegate ${label} requires caller powers`);
  }
  await null;
  try {
    return await E(
      /** @type {{ lookup: (petName: string | string[]) => Promise<unknown> }} */ (
        powers
      ),
    ).lookup(petName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `delegate ${label} power ${JSON.stringify(petName)} is not resolvable: ${message}`,
    );
  }
};

/**
 * @param {unknown} powers
 * @param {string | string[]} petName
 * @returns {Promise<CodeModeRuntimeConfig['model']>}
 */
const lookupDelegatedModelProfile = async (powers, petName) => {
  const profile = await lookupDelegatedPower(powers, petName, 'modelProfile');
  if (!isRecord(profile)) {
    throw new Error(
      `delegate modelProfile ${JSON.stringify(petName)} must resolve to a model config record`,
    );
  }
  return /** @type {CodeModeRuntimeConfig['model']} */ (profile);
};

/**
 * @param {object} options
 * @param {Record<string, unknown>} options.requestedPowers
 * @param {CodeModeRuntimeConfig} options.callerConfig
 * @param {unknown} options.callerPowers
 * @returns {Promise<{
 *   namedPowers: import('./lal-code-mode.js').LalCodeModeGlobal[],
 *   endowments: Record<string, unknown>,
 * }>}
 */
const resolveDelegatedNamedPowers = async ({
  requestedPowers,
  callerConfig,
  callerPowers,
}) => {
  const catalog = makeNamedPowerCatalog(callerConfig);
  const requestedNamedPowers = Object.entries(requestedPowers).filter(
    ([name]) => !RESERVED_POWER_NAMES.has(name),
  );
  const resolvedNamedPowers = await Promise.all(
    requestedNamedPowers.map(async ([name, requestPetName]) => {
      await null;
      if (!isPetName(requestPetName)) {
        throw new Error(`delegate power ${name} must be a string or string[]`);
      }
      const catalogPower = catalog.get(name);
      if (catalogPower !== undefined) {
        const callerPetName = catalogPower.petName || name;
        if (!petNamesEqual(requestPetName, callerPetName)) {
          throw new Error(
            `delegate power ${JSON.stringify(requestPetName)} is not held by caller as ${name}`,
          );
        }
      }
      const endowment = await lookupDelegatedPower(
        callerPowers,
        requestPetName,
        name,
      );
      return harden({
        name,
        endowment,
        namedPower: harden({
          name,
          petName: requestPetName,
          type: catalogPower?.type,
          description: catalogPower?.description,
        }),
      });
    }),
  );
  return harden({
    namedPowers: harden(
      resolvedNamedPowers.map(({ namedPower }) => namedPower),
    ),
    endowments: harden(
      Object.fromEntries(
        resolvedNamedPowers.map(({ name, endowment }) => [name, endowment]),
      ),
    ),
  });
};

/**
 * @param {object} options
 * @param {unknown} options.direct
 * @param {string} options.callerPetName
 * @param {unknown} options.requestPetName
 * @param {unknown} options.callerPowers
 * @param {string} options.label
 * @returns {Promise<unknown>}
 */
const resolveDelegatedPower = async ({
  direct,
  callerPetName,
  requestPetName,
  callerPowers,
  label,
}) => {
  if (requestPetName !== undefined && !isBindingPetName(requestPetName)) {
    throw new Error(`delegate ${label} power must be a string`);
  }
  const petName = requestPetName || callerPetName;
  if (direct !== undefined) {
    if (!petNamesEqual(petName, callerPetName)) {
      throw new Error(
        `delegate ${label} power ${JSON.stringify(petName)} is not held by caller`,
      );
    }
    return direct;
  }
  return lookupDelegatedPower(callerPowers, petName, label);
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {object} options
 * @param {Partial<CodeModeRuntimeConfig>} options.callerConfig
 * @param {unknown} [options.callerPowers]
 * @param {Record<string, unknown>} [options.endowments]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {import('@earendil-works/pi-ai').Model<string>} [options.model]
 * @param {(provider: string) => Promise<string | undefined> | string | undefined} [options.getApiKey]
 * @param {(runtime: CodeModeRuntime, prompt: string) => Promise<unknown>} [options.runAgent]
 * @returns {ToolRecord}
 */
export const makeCodeModeDelegateTool = ({
  callerConfig,
  callerPowers = undefined,
  endowments = {},
  env = undefined,
  model = undefined,
  getApiKey = undefined,
  runAgent = async (runtime, prompt) => {
    await runtime.agent.prompt(prompt);
    await runtime.agent.waitForIdle();
    return harden({
      status: 'completed',
      messages: runtime.agent.state.messages.length,
      globals: runtime.globals.map(global => global.name),
    });
  },
}) => {
  const normalizedCallerConfig = normalizeCodeModeRuntimeConfig(callerConfig);
  return makeTool({
    name: 'delegateCodeMode',
    description:
      'Call a delegated Endo code-mode Pi agent with caller-held powers.',
    parameters: DELEGATE_PARAMETERS,
    execute: async args => {
      const { prompt, powers: requestedPowers = {}, modelProfile } = args;
      if (typeof prompt !== 'string') {
        throw new Error('delegateCodeMode.prompt must be a string');
      }
      if (!isRecord(requestedPowers)) {
        throw new Error('delegateCodeMode.powers must be a record');
      }
      if (modelProfile !== undefined && !isPetName(modelProfile)) {
        throw new Error('delegateCodeMode.modelProfile must be a string');
      }
      const requestedGitMode =
        requestedPowers.gitMode === undefined
          ? 'readOnly'
          : requestedPowers.gitMode;
      if (
        requestedGitMode !== 'readOnly' &&
        requestedGitMode !== 'readWrite'
      ) {
        throw new Error('delegateCodeMode.powers.gitMode is invalid');
      }
      if (
        normalizedCallerConfig.powers.gitMode === 'readOnly' &&
        requestedGitMode === 'readWrite'
      ) {
        throw new Error('delegated code-mode agent cannot upgrade Git authority');
      }
      await null;
      let delegatedModel = normalizedCallerConfig.model;
      if (modelProfile !== undefined) {
        delegatedModel = await lookupDelegatedModelProfile(
          callerPowers,
          modelProfile,
        );
      }
      const delegatedNamedPowers = await resolveDelegatedNamedPowers({
        requestedPowers,
        callerConfig: normalizedCallerConfig,
        callerPowers,
      });

      const workspace = await resolveDelegatedPower({
        direct: normalizedCallerConfig.powers.workspace,
        callerPetName:
          normalizedCallerConfig.powers.workspacePetName || 'workspace',
        requestPetName: requestedPowers.workspace,
        callerPowers,
        label: 'workspace',
      });
      const git = await resolveDelegatedPower({
        direct: normalizedCallerConfig.powers.git,
        callerPetName: normalizedCallerConfig.powers.gitPetName || 'git',
        requestPetName: requestedPowers.git,
        callerPowers,
        label: 'git',
      });
      const workspacePetName =
        (isBindingPetName(requestedPowers.workspace)
          ? requestedPowers.workspace
          : undefined) ||
        normalizedCallerConfig.powers.workspacePetName ||
        'workspace';
      const gitPetName =
        (isBindingPetName(requestedPowers.git)
          ? requestedPowers.git
          : undefined) ||
        normalizedCallerConfig.powers.gitPetName ||
        'git';

      const runtime = makeCodeModeRuntime({
        config: harden({
          model: delegatedModel,
          powers: harden({
            workspace,
            workspacePetName,
            git,
            gitPetName,
            gitMode: requestedGitMode,
            namedPowers: delegatedNamedPowers.namedPowers,
          }),
          tools: harden({
            mode: 'executeOnly',
            include: harden(['workspace', 'git']),
          }),
        }),
        powers: callerPowers,
        endowments: harden({
          ...endowments,
          ...delegatedNamedPowers.endowments,
        }),
        env,
        model,
        getApiKey,
      });
      return runAgent(runtime, prompt);
    },
  });
};
harden(makeCodeModeDelegateTool);
