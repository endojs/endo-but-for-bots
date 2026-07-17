// @ts-check
/// <reference types="ses"/>

/** @import { Model } from '@earendil-works/pi-ai' */
/** @import { Agent, AgentMessage, StreamFn } from '@earendil-works/pi-agent-core' */
/** @import { Credentials, GetApiKey } from './harness/credentials.js' */
/** @import { ThinkingLevel } from './harness/model.js' */
/** @import { Evaluate, CodeModeGlobal, CodeModePower, PowerHandle, LookupPowers } from '@endo/agent-tools/code-mode/evaluate-tool.js' */

import { toPiAgentTool } from '@endo/agent-tools/adapters/pi.js';
import { toolResultToSmallcaps } from '@endo/agent-tools/adapters/smallcaps.js';
import { makeWorkspaceGlobal } from '@endo/agent-tools/code-mode-globals/fs.js';
import { makeGitGlobal } from '@endo/agent-tools/code-mode-globals/git.js';
import { makeCompartmentEvaluate } from '@endo/agent-tools/code-mode/compartment.js';
import { makeDaemonEvaluate } from '@endo/agent-tools/code-mode/daemon.js';
import {
  formatGlobalDeclarations,
  normalizeGlobals,
} from '@endo/agent-tools/code-mode/declarations.js';
import { makeEvaluateTool } from '@endo/agent-tools/code-mode/evaluate-tool.js';
import { E } from '@endo/eventual-send';
import { isGitHistoryRewrite, isGitReadOnly } from '@endo/exo-git';
import {
  isFilesystemReadOnly,
  readOnly as readOnlyFilesystem,
} from '@endo/platform/fs/extended';

import { defineAgent } from './define-agent.js';
import { getAmbientEnv, makeEnvCredentials } from './harness/credentials.js';

/**
 * @typedef {'inspect' | 'edit' | 'rewriteHistory'} CodeModeAccess
 *
 * @typedef {CodeModeGlobal & { power?: PowerHandle }} NamedCodeModePower
 *
 * @typedef {object} CodeModePowers
 * @property {PowerHandle} [workspace]
 * @property {string | string[]} [workspacePetName]
 * @property {PowerHandle} [git]
 * @property {string | string[]} [gitPetName]
 * @property {NamedCodeModePower[]} [namedPowers]
 *
 * @typedef {object} CodeModeRepository
 * @property {string} remoteUrl Repository setup data consumed only by a
 *   trusted host provisioner.
 * @property {unknown} [credential] Host-only credential capability.
 * @property {boolean} [allowLocalFileTransport]
 * @property {Record<string, string>} [identity]
 *
 * @typedef {object} InProcessCodeModeHost
 * @property {'inProcess'} kind
 * @property {LookupPowers} [powers] Optional lookup handle for petname-only
 *   power declarations.
 * @property {Record<string, unknown>} [endowments]
 * @property {(value: unknown, resultName: string | string[]) => Promise<void> | void} [storeResult]
 * @property {() => Promise<void> | void} [onContainedEventualSendRejection]
 *
 * @typedef {object} DaemonPreparationAttestation
 * @property {CodeModeAccess} access
 * @property {{ petName: string | string[], readOnly: boolean }} [workspace]
 * @property {{ petName: string | string[], readOnly: boolean, historyRewrite: boolean }} [git]
 * @property {readonly { name: string, petName: string | string[] }[]} [namedPowers]
 *
 * @typedef {object} DaemonCodeModePowers
 * @property {(request: { access: CodeModeAccess, powers: CodeModePowers, repository?: CodeModeRepository }) => Promise<DaemonPreparationAttestation>} prepareCodeMode
 * @property {(workerName: undefined, source: string, codeNames: string[], petNames: (string | string[])[], resultName?: string | string[]) => Promise<unknown>} evaluate
 *
 * @typedef {object} DaemonCodeModeHost
 * @property {'daemon'} kind
 * @property {DaemonCodeModePowers} powers A trusted daemon host boundary.
 *
 * @typedef {object} PrepareCodeModeOptions
 * @property {InProcessCodeModeHost | DaemonCodeModeHost} host
 * @property {CodeModeAccess} access
 * @property {CodeModePowers} [powers]
 * @property {CodeModeRepository} [repository]
 *
 * @typedef {object} MakeCodeModeAgentOptions
 * @property {Model<string>} model
 * @property {Evaluate} evaluate Host-neutral evaluator returned by
 *   `prepareCodeMode`.
 * @property {CodeModeGlobal[]} globals Host-attested globals returned by
 *   `prepareCodeMode`.
 * @property {Credentials} [credentials]
 * @property {string} [systemPrompt]
 * @property {string} [preamble]
 * @property {AgentMessage[]} [messages]
 * @property {StreamFn} [streamFn]
 * @property {GetApiKey} [getApiKey]
 * @property {ThinkingLevel} [thinkingLevel]
 */

/**
 * Build the system prompt for the narrow code-mode agent.
 *
 * @param {CodeModeGlobal[]} globals
 * @param {{ preamble?: string }} [options]
 * @returns {string}
 */
export const makeCodeModeSystemPrompt = (globals, options = {}) => {
  const normalized = normalizeGlobals(globals);
  const preamble =
    options.preamble ||
    'You are codeMode, an Endo code-mode agent. You solve tasks by writing JavaScript and calling the evaluate tool.';
  return `${preamble}

You have exactly one tool: evaluate. Do not call any other tool and do not answer in prose when a tool call can do the work.

The evaluate tool evaluates JavaScript source in an Endo Compartment. The compartment includes hardened SES globals plus the powers listed below. These powers are already in lexical scope; do not look them up by pet name. The TypeScript declarations below are your primary reference: use them to pick a method and its arguments before your first call rather than probing at runtime. They may be a subset of a capability's live surface, so if you need a method that is not declared, discover it with E(capability).__getMethodNames__().

Use E(capability).method(...) for remotable capabilities. Top-level await is not available, so use an async IIFE when you need multiple awaits or a final awaited result:

\`\`\`js
(async () => {
  const value = await E(example).method();
  return value;
})()
\`\`\`

Return the desired value as the source completion value. Use resultName only when the user asks you to store the result for later.

Available powers:

\`\`\`ts
declare const E;
${formatGlobalDeclarations(normalized)}
\`\`\`
`;
};
harden(makeCodeModeSystemPrompt);

const CODE_MODE_ACCESS = harden(['inspect', 'edit', 'rewriteHistory']);

/**
 * @param {unknown} access
 * @returns {asserts access is CodeModeAccess}
 */
const assertCodeModeAccess = access => {
  if (!CODE_MODE_ACCESS.includes(/** @type {CodeModeAccess} */ (access))) {
    throw new Error(
      'code-mode access must be "inspect", "edit", or "rewriteHistory"',
    );
  }
};

/**
 * @param {LookupPowers | undefined} powers
 * @param {string | string[]} petName
 * @param {string} label
 * @returns {Promise<PowerHandle>}
 */
const lookupRequiredPower = async (powers, petName, label) => {
  if (powers === undefined || powers === null) {
    throw new Error(`code-mode ${label} capability requires lookup powers`);
  }
  return E(powers).lookup(petName);
};

/**
 * @param {PowerHandle | undefined} direct
 * @param {string | string[] | undefined} petName
 * @param {LookupPowers | undefined} lookupPowers
 * @param {string} label
 * @returns {Promise<PowerHandle | undefined>}
 */
const resolvePower = async (direct, petName, lookupPowers, label) => {
  if (direct !== undefined) {
    return direct;
  }
  if (petName !== undefined) {
    return lookupRequiredPower(lookupPowers, petName, label);
  }
  return undefined;
};

/**
 * Validate an in-process Filesystem before granting writable code-mode access.
 *
 * @param {CodeModePower} workspace
 * @param {CodeModeAccess} access
 */
const assertWritableWorkspace = (workspace, access) => {
  const readOnly = isFilesystemReadOnly(workspace);
  if (readOnly !== false) {
    const posture = readOnly === true ? 'read-only' : 'unknown';
    throw new Error(
      `code-mode ${access} requires a proven writable Filesystem capability; received ${posture} posture`,
    );
  }
};

/**
 * Validate an in-process Git before granting writable code-mode access.
 * Unknown posture never defaults to writable.
 *
 * @param {CodeModePower} git
 * @param {CodeModeAccess} access
 */
const assertGitAccess = (git, access) => {
  const readOnly = isGitReadOnly(git);
  const historyRewrite = isGitHistoryRewrite(git);
  if (readOnly !== false) {
    const posture = readOnly === true ? 'read-only' : 'unknown';
    throw new Error(
      `code-mode ${access} requires a proven writable Git capability; received ${posture} posture`,
    );
  }
  if (access === 'edit') {
    if (historyRewrite === true) {
      throw new Error(
        'code-mode edit cannot attenuate history-rewrite authority from this Git capability; supply an ordinary writable Git capability',
      );
    }
    if (historyRewrite !== false) {
      throw new Error(
        'code-mode edit requires proven ordinary Git authority; history-rewrite posture is unknown',
      );
    }
  } else if (historyRewrite !== true) {
    const posture = historyRewrite === false ? 'ordinary' : 'unknown';
    throw new Error(
      `code-mode rewriteHistory requires proven history-rewrite Git authority; received ${posture} posture`,
    );
  }
};

/**
 * @param {NamedCodeModePower[]} namedPowers
 * @param {LookupPowers | undefined} lookupPowers
 * @returns {Promise<{ globals: CodeModeGlobal[], endowments: Record<string, unknown> }>}
 */
const resolveNamedPowers = async (namedPowers, lookupPowers) => {
  await null;
  const globals = normalizeGlobals(
    namedPowers.map(({ power: _power, ...global }) => global),
  );
  /** @type {Record<string, unknown>} */
  const endowments = {};
  for (let index = 0; index < namedPowers.length; index += 1) {
    const namedPower = namedPowers[index];
    const global = globals[index];
    // eslint-disable-next-line no-await-in-loop
    endowments[global.name] = await (namedPower.power !== undefined
      ? namedPower.power
      : lookupRequiredPower(
          lookupPowers,
          global.petName || global.name,
          global.name,
        ));
  }
  return harden({ globals, endowments: harden(endowments) });
};

/**
 * @param {PrepareCodeModeOptions & { host: InProcessCodeModeHost }} options
 * @returns {Promise<{ evaluate: Evaluate, globals: CodeModeGlobal[] }>}
 */
const prepareInProcessCodeMode = async ({
  host,
  powers = {},
  repository,
  access,
}) => {
  if (repository !== undefined) {
    throw new Error(
      'code-mode in-process repository setup is unsupported; supply existing powers or use a trusted daemon provisioner',
    );
  }
  let workspace = await resolvePower(
    powers.workspace,
    powers.workspacePetName,
    host.powers,
    'workspace',
  );
  let git = await resolvePower(
    powers.git,
    powers.gitPetName,
    host.powers,
    'git',
  );

  if (access === 'inspect') {
    if (workspace !== undefined) {
      workspace = readOnlyFilesystem(workspace);
    }
    if (git !== undefined) {
      git = await E(git).readOnly();
    }
  } else {
    if (workspace !== undefined) {
      assertWritableWorkspace(workspace, access);
    }
    if (git !== undefined) {
      assertGitAccess(git, access);
    }
  }

  const named = await resolveNamedPowers(powers.namedPowers || [], host.powers);
  /** @type {CodeModeGlobal[]} */
  const globals = [];
  /** @type {Record<string, unknown>} */
  const endowments = { ...(host.endowments || {}), E };
  if (workspace !== undefined) {
    endowments.workspace = workspace;
    globals.push(
      makeWorkspaceGlobal({
        name: 'workspace',
        readOnly: access === 'inspect',
      }),
    );
  }
  if (git !== undefined) {
    endowments.git = git;
    globals.push(
      makeGitGlobal({
        name: 'git',
        readOnly: access === 'inspect',
        historyRewrite: access === 'rewriteHistory',
      }),
    );
  }
  Object.assign(endowments, named.endowments);
  globals.push(...named.globals);
  const normalizedGlobals = normalizeGlobals(globals);
  return harden({
    evaluate: makeCompartmentEvaluate({
      endowments: harden(endowments),
      storeResult: host.storeResult,
      onContainedEventualSendRejection: host.onContainedEventualSendRejection,
    }),
    globals: normalizedGlobals,
  });
};

/**
 * @param {unknown} value
 * @returns {value is string | string[]}
 */
const isPetName = value =>
  typeof value === 'string' ||
  (Array.isArray(value) && value.every(part => typeof part === 'string'));

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string | string[]}
 */
const requirePetName = (value, label) => {
  if (!isPetName(value)) {
    throw new Error(
      `daemon code-mode ${label} attestation has invalid petName`,
    );
  }
  return value;
};

/**
 * @param {PrepareCodeModeOptions & { host: DaemonCodeModeHost }} options
 * @returns {Promise<{ evaluate: Evaluate, globals: CodeModeGlobal[] }>}
 */
const prepareDaemonCodeMode = async ({
  host,
  powers = {},
  repository,
  access,
}) => {
  const namedGlobals = normalizeGlobals(
    (powers.namedPowers || []).map(({ power: _power, ...global }) => global),
  );
  const requestPowers = harden({
    ...(powers.workspace !== undefined && { workspace: powers.workspace }),
    ...(powers.workspacePetName !== undefined && {
      workspacePetName: powers.workspacePetName,
    }),
    ...(powers.git !== undefined && { git: powers.git }),
    ...(powers.gitPetName !== undefined && {
      gitPetName: powers.gitPetName,
    }),
    namedPowers: harden(
      (powers.namedPowers || []).map((namedPower, index) =>
        harden({
          name: namedGlobals[index].name,
          petName: namedGlobals[index].petName,
          ...(namedPower.power !== undefined && { power: namedPower.power }),
        }),
      ),
    ),
  });
  const attestation = await E(host.powers).prepareCodeMode(
    harden({
      access,
      powers: requestPowers,
      ...(repository !== undefined && { repository: harden(repository) }),
    }),
  );
  if (
    typeof attestation !== 'object' ||
    attestation === null ||
    attestation.access !== access
  ) {
    throw new Error('daemon code-mode preparation returned invalid access');
  }

  /** @type {CodeModeGlobal[]} */
  const globals = [];
  if (attestation.workspace !== undefined) {
    const { petName, readOnly } = attestation.workspace;
    if (readOnly !== (access === 'inspect')) {
      throw new Error(
        'daemon code-mode workspace attestation contradicts requested access',
      );
    }
    globals.push(
      makeWorkspaceGlobal({
        name: 'workspace',
        petName: requirePetName(petName, 'workspace'),
        readOnly,
      }),
    );
  }
  if (attestation.git !== undefined) {
    const { petName, readOnly, historyRewrite } = attestation.git;
    const expectedReadOnly = access === 'inspect';
    const expectedHistoryRewrite = access === 'rewriteHistory';
    if (
      readOnly !== expectedReadOnly ||
      historyRewrite !== expectedHistoryRewrite
    ) {
      throw new Error(
        'daemon code-mode Git attestation contradicts requested access',
      );
    }
    globals.push(
      makeGitGlobal({
        name: 'git',
        petName: requirePetName(petName, 'git'),
        readOnly,
        historyRewrite,
      }),
    );
  }

  const attestedNamed = attestation.namedPowers || [];
  if (attestedNamed.length !== namedGlobals.length) {
    throw new Error(
      'daemon code-mode named-power attestation does not match the request',
    );
  }
  for (let index = 0; index < namedGlobals.length; index += 1) {
    const expected = namedGlobals[index];
    const actual = attestedNamed[index];
    if (
      actual.name !== expected.name ||
      JSON.stringify(actual.petName) !== JSON.stringify(expected.petName)
    ) {
      throw new Error(
        `daemon code-mode named-power attestation does not match ${expected.name}`,
      );
    }
  }
  globals.push(...namedGlobals);
  return harden({
    evaluate: makeDaemonEvaluate(host.powers),
    globals: normalizeGlobals(globals),
  });
};

/**
 * Prepare host-neutral inputs for the generic code-mode agent maker.
 *
 * Host selection controls where evaluation and authority realization happen.
 * Access selection independently controls the repository authority exposed to
 * evaluated code. `inspect` attenuates the supported workspace and Git powers;
 * arbitrary named powers remain unchanged and retain their caller-supplied
 * descriptors.
 *
 * @param {PrepareCodeModeOptions} options
 * @returns {Promise<{ evaluate: Evaluate, globals: CodeModeGlobal[] }>}
 */
export const prepareCodeMode = async options => {
  const { host, access } = options;
  assertCodeModeAccess(access);
  if (!host || typeof host !== 'object') {
    throw new Error('code-mode host must be an object');
  }
  if (host.kind === 'inProcess') {
    return prepareInProcessCodeMode(
      /** @type {PrepareCodeModeOptions & { host: InProcessCodeModeHost }} */ (
        options
      ),
    );
  }
  if (host.kind === 'daemon') {
    return prepareDaemonCodeMode(
      /** @type {PrepareCodeModeOptions & { host: DaemonCodeModeHost }} */ (
        options
      ),
    );
  }
  throw new Error('code-mode host.kind must be "inProcess" or "daemon"');
};
harden(prepareCodeMode);

/**
 * Construct a live code-mode agent whose sole tool is `evaluate`.
 * Resource acquisition and authority policy belong to `prepareCodeMode`; this
 * maker consumes only the resulting host-neutral evaluator and descriptors.
 *
 * @param {MakeCodeModeAgentOptions} options
 * @returns {{ agent: Agent, globals: CodeModeGlobal[], evaluate: Evaluate, systemPrompt: string, model: Model<string> }}
 */
export const makeCodeModeAgent = options => {
  const {
    model,
    evaluate,
    credentials = makeEnvCredentials(getAmbientEnv()),
    messages,
    streamFn,
    getApiKey,
    thinkingLevel,
    preamble,
  } = options;
  if (typeof evaluate !== 'function') {
    throw new Error(
      'makeCodeModeAgent requires an evaluate function from prepareCodeMode',
    );
  }
  const globals = normalizeGlobals(options.globals);
  const systemPrompt =
    options.systemPrompt || makeCodeModeSystemPrompt(globals, { preamble });
  const tool = makeEvaluateTool(evaluate, globals);

  const maker = defineAgent({
    model,
    instructions: systemPrompt,
    tools: [toPiAgentTool(tool, { renderToolResult: toolResultToSmallcaps })],
  });
  const agent = maker({
    credentials,
    messages,
    streamFn,
    getApiKey,
    thinkingLevel,
  });
  // The returned record is intentionally NOT hardened: `agent` is a live
  // pi-agent-core instance that mutates its own run state while driving a
  // conversation.
  return { agent, globals, evaluate, systemPrompt, model };
};
harden(makeCodeModeAgent);
