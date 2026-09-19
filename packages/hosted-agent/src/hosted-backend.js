// @ts-check

import { Fail, q } from '@endo/errors';
import { M } from '@endo/patterns';

/** The only Endo authority a hosted backend receives from Floot. */
export const HostedToolSetInterface = M.interface('HostedToolSet', {
  describe: M.call().returns(M.promise()),
  execute: M.call(M.string(), M.record()).returns(M.promise()),
  help: M.call().returns(M.string()),
});
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(HostedToolSetInterface);

/**
 * Provider-neutral facets for a hosted agent backend.
 *
 * `interrupt()` is a turn-terminal barrier, not session shutdown.
 * Factory `stop()` preserves durable state; `destroy()` removes it.
 * Both reach the durable owner when no live admin facet survives.
 */
export const HostedTurnBackendInterface = M.interface('HostedTurnBackend', {
  send: M.call(M.string())
    .optional(M.recordOf(M.string(), M.any()))
    .returns(M.promise()),
  models: M.call().returns(M.promise()),
  interrupt: M.call().returns(M.promise()),
  acknowledge: M.call(M.string()).returns(M.promise()),
  status: M.call().returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(HostedTurnBackendInterface);

export const HostedTurnBackendAdminInterface = M.interface(
  'HostedTurnBackendAdmin',
  {
    terminate: M.call().returns(M.promise()),
    help: M.call().returns(M.string()),
  },
);
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(HostedTurnBackendAdminInterface);

export const HostedBackendFactoryInterface = M.interface(
  'HostedBackendFactory',
  {
    describe: M.call().returns(M.promise()),
    listModels: M.call().returns(M.promise()),
    create: M.call(M.record(), M.remotable('HostedToolSet')).returns(
      M.promise(),
    ),
    stop: M.call(M.record()).returns(M.promise()),
    destroy: M.call(M.record()).returns(M.promise()),
    help: M.call().returns(M.string()),
  },
);
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(HostedBackendFactoryInterface);

/**
 * How a backend carries a conversation between turns, and so what Floot's own
 * tree must retain (see `@endo/floot/BACKEND-DESIGN.md`):
 *
 * - `explicit`: Floot supplies the whole history on every turn.
 * - `opaque`: the backend keeps the conversation; the tree is display-only.
 * - `opaque-reconciled`: as `opaque`, with per-turn checkpoints Floot
 *   acknowledges, so a stopped or failed turn is rolled back on both sides.
 * - `transcript`: the backend's persisted transcript retains every delivered
 *   prompt and whatever streamed before a stop or a failure; Floot mirrors
 *   those into the tree rather than dropping them.
 *
 * A closed set: a value neither side knows would silently degrade to the
 * drop-on-stop behaviour, so the descriptor validator refuses it.
 */
export const CONTINUITY_MODES = harden([
  'explicit',
  'opaque',
  'opaque-reconciled',
  'transcript',
]);

/**
 * What a system prompt has to know about the place a model runs, as plain
 * data a backend declares about itself. A prompt written for one backend is
 * wrong on another in exactly these ways: the model sees Endo's tools under
 * other names, it has (or lacks) a shell and file tools of its own, and the
 * session's workspace is (or is not) a directory it can simply edit.
 *
 * - `toolNamePrefix`: what the backend's runtime puts in front of every Endo
 *   tool name (`endo_` for an MCP server named `endo` under opencode,
 *   `mcp__endo__` under Claude Code). Empty when names are passed unchanged.
 * - `toolNames`: exceptions to the prefix, by Endo tool name (Codex renames
 *   only `exec`, to keep it apart from its native exec).
 * - `nativeTools`: the model has its runtime's own shell and file tools,
 *   acting inside a sandbox that cannot reach Endo capabilities.
 * - `workspacePath`: where that sandbox mounts a session's git workspace;
 *   empty when it does not.
 *
 * @typedef {object} PromptEnvironment
 * @property {string} toolNamePrefix
 * @property {Record<string, string>} toolNames
 * @property {boolean} nativeTools
 * @property {string} workspacePath
 */

const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const TOOL_NAME_PREFIX = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const PROMPT_ENVIRONMENT_KEYS = harden([
  'nativeTools',
  'toolNamePrefix',
  'toolNames',
  'workspacePath',
]);

/**
 * Validate and copy a backend's declared prompt environment. Every string in
 * it ends up inside a system prompt, so each is held to the shape of the
 * thing it names rather than accepted as free text.
 *
 * @param {any} environment
 * @returns {PromptEnvironment}
 */
export const assertPromptEnvironment = environment => {
  (environment &&
    typeof environment === 'object' &&
    !Array.isArray(environment) &&
    Object.keys(environment).sort().join(',') ===
      PROMPT_ENVIRONMENT_KEYS.join(',')) ||
    Fail`Prompt environment must be a record of ${q(PROMPT_ENVIRONMENT_KEYS)}`;
  const { toolNamePrefix, nativeTools, workspacePath } = environment;
  (typeof toolNamePrefix === 'string' &&
    (toolNamePrefix === '' || TOOL_NAME_PREFIX.test(toolNamePrefix))) ||
    Fail`Prompt environment has an invalid tool name prefix`;
  const declaredNames = environment.toolNames;
  (declaredNames &&
    typeof declaredNames === 'object' &&
    !Array.isArray(declaredNames)) ||
    Fail`Prompt environment has invalid tool names`;
  // Read once, then check and keep what was read: an object that answers
  // differently the second time must not get an unchecked answer through.
  const nameEntries = Object.entries(declaredNames);
  (nameEntries.length <= 64 &&
    nameEntries.every(
      ([from, to]) =>
        TOOL_NAME.test(from) && typeof to === 'string' && TOOL_NAME.test(to),
    )) ||
    Fail`Prompt environment has invalid tool names`;
  typeof nativeTools === 'boolean' ||
    Fail`Prompt environment must say whether the model has native tools`;
  (typeof workspacePath === 'string' &&
    (workspacePath === '' ||
      (/^\/[A-Za-z0-9._-]{1,64}(\/[A-Za-z0-9._-]{1,64}){0,7}$/.test(
        workspacePath,
      ) &&
        !workspacePath
          .split('/')
          .some(part => part === '.' || part === '..')))) ||
    Fail`Prompt environment has an invalid workspace path`;
  workspacePath === '' ||
    nativeTools ||
    Fail`A workspace path means nothing to a model without native tools`;
  return harden({
    toolNamePrefix,
    toolNames: Object.fromEntries(nameEntries),
    nativeTools,
    workspacePath,
  });
};
harden(assertPromptEnvironment);

const REQUIRED_DESCRIPTOR_KEYS = harden([
  'continuity',
  'id',
  'kind',
  'title',
  'toolOwnership',
]);
const OPTIONAL_DESCRIPTOR_KEYS = harden([
  'promptEnvironment',
  'supportedNetworkPolicies',
]);

/**
 * Validate and project the exact capability-free descriptor fields Floot uses
 * for selection and recovery.
 *
 * @param {any} descriptor
 */
export const assertHostedBackendDescriptor = descriptor => {
  (descriptor &&
    typeof descriptor === 'object' &&
    !Array.isArray(descriptor) &&
    REQUIRED_DESCRIPTOR_KEYS.every(key => Object.hasOwn(descriptor, key)) &&
    Object.keys(descriptor).every(
      key =>
        REQUIRED_DESCRIPTOR_KEYS.includes(key) ||
        OPTIONAL_DESCRIPTOR_KEYS.includes(key),
    )) ||
    Fail`Hosted backend descriptor must be a record`;
  (typeof descriptor.id === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(descriptor.id)) ||
    Fail`Hosted backend descriptor has an invalid id`;
  (typeof descriptor.title === 'string' && descriptor.title !== '') ||
    Fail`Hosted backend descriptor has an invalid title`;
  descriptor.kind === 'hosted' ||
    Fail`Hosted backend descriptor must have kind hosted`;
  CONTINUITY_MODES.includes(descriptor.continuity) ||
    Fail`Hosted backend descriptor must declare continuity as one of ${q(
      CONTINUITY_MODES,
    )}, not ${q(descriptor.continuity)}`;
  (typeof descriptor.toolOwnership === 'string' &&
    descriptor.toolOwnership !== '') ||
    Fail`Hosted backend descriptor must declare tool ownership`;
  if (descriptor.supportedNetworkPolicies !== undefined) {
    (Array.isArray(descriptor.supportedNetworkPolicies) &&
      descriptor.supportedNetworkPolicies.every(policy =>
        ['off', 'public-internet'].includes(policy),
      ) &&
      new Set(descriptor.supportedNetworkPolicies).size ===
        descriptor.supportedNetworkPolicies.length) ||
      Fail`Invalid supported network policies`;
  }
  return harden({
    id: descriptor.id,
    title: descriptor.title,
    kind: descriptor.kind,
    continuity: descriptor.continuity,
    toolOwnership: descriptor.toolOwnership,
    ...(descriptor.supportedNetworkPolicies === undefined
      ? {}
      : { supportedNetworkPolicies: [...descriptor.supportedNetworkPolicies] }),
    ...(descriptor.promptEnvironment === undefined
      ? {}
      : {
          promptEnvironment: assertPromptEnvironment(
            descriptor.promptEnvironment,
          ),
        }),
  });
};
harden(assertHostedBackendDescriptor);

/**
 * Validate and project Floot's exact capability-free model catalog DTO.
 *
 * Provider adapters are responsible for translating their native protocol into
 * this record before it crosses the backend seam.
 *
 * @param {any} candidate
 */
export const normalizeHostedModelDescriptor = candidate => {
  (candidate &&
    typeof candidate === 'object' &&
    Object.keys(candidate).sort().join(',') ===
      'default,defaultReasoningEffort,description,id,reasoningEfforts,title') ||
    Fail`Hosted model descriptor must be a record`;
  const id = /** @type {unknown} */ (candidate.id);
  (typeof id === 'string' && id !== '' && id.length <= 256) ||
    Fail`Hosted model descriptor has an invalid id`;
  const title = candidate.title;
  (typeof title === 'string' && title !== '' && title.length <= 1024) ||
    Fail`Hosted model descriptor has an invalid title`;
  const description = candidate.description;
  (typeof description === 'string' && description.length <= 16_384) ||
    Fail`Hosted model descriptor has an invalid description`;
  const rawEfforts = candidate.reasoningEfforts;
  (Array.isArray(rawEfforts) &&
    rawEfforts.length <= 64 &&
    rawEfforts.every(
      effort =>
        typeof effort === 'string' && effort !== '' && effort.length <= 64,
    ) &&
    new Set(rawEfforts).size === rawEfforts.length) ||
    Fail`Hosted model descriptor has invalid reasoning efforts`;
  typeof candidate.default === 'boolean' ||
    Fail`Hosted model descriptor has an invalid default marker`;
  const defaultReasoningEffort = candidate.defaultReasoningEffort;
  defaultReasoningEffort === null ||
    (typeof defaultReasoningEffort === 'string' &&
      rawEfforts.includes(defaultReasoningEffort)) ||
    Fail`Hosted model descriptor has an invalid default reasoning effort`;
  return harden({
    id,
    title,
    description,
    default: candidate.default,
    defaultReasoningEffort,
    reasoningEfforts: harden([...rawEfforts]),
  });
};
harden(normalizeHostedModelDescriptor);
