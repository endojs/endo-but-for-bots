// @ts-check
/// <reference types="ses"/>

/** @import { Model } from '@earendil-works/pi-ai' */
/** @import { Agent, AgentMessage, StreamFn } from '@earendil-works/pi-agent-core' */
/** @import { Credentials, GetApiKey, ThinkingLevel } from './harness/types.js' */
/** @import { CodeModeGlobal, CodeModePower, Evaluate, LookupPowers, PowerHandle, StoreValue } from '@endo/agent-tools/code-mode/types.js' */
/** @import { CodeModePowers, GitLoopOptions, MakeCodeModeAgentOptions } from './code-mode/types.js' */

import { E } from '@endo/eventual-send';
import { makeCompartmentEvaluate } from '@endo/agent-tools/code-mode/compartment.js';
import { makeEvaluateTool } from '@endo/agent-tools/code-mode/evaluate-tool.js';
import {
  formatGlobalDeclarations,
  normalizeGlobals,
} from '@endo/agent-tools/code-mode/declarations.js';
import { toPiAgentTool } from '@endo/agent-tools/adapters/pi.js';
import { toolResultToSmallcaps } from '@endo/agent-tools/adapters/smallcaps.js';

import {
  makeFilesystemGlobal,
  makeWorkspaceGlobal,
} from '@endo/agent-tools/code-mode-globals/fs.js';
import { makeGitGlobal } from '@endo/agent-tools/code-mode-globals/git.js';
import { lineageOf } from '@endo/daemon/src/mount.js';
import { isGitHistoryRewrite, isGitReadOnly } from '@endo/exo-git';
import {
  isFilesystemReadOnly,
  isFilesystemReadWrite,
} from '@endo/platform/fs/extended';
import { defineAgent } from './define-agent.js';
import { getAmbientEnv, makeEnvCredentials } from './harness/credentials.js';

/**
 * Build the system prompt for the narrow code-mode agent.
 *
 * @param {CodeModeGlobal[]} globals
 * @param {{ preamble?: string, storeValue?: boolean, preserveTools?: boolean }} [options]
 * @returns {string}
 */
export const makeCodeModeSystemPrompt = (globals, options = {}) => {
  const normalized = normalizeGlobals(globals);
  const resultNameGuidance = options.storeValue
    ? ' Use resultName only when the user asks you to store the result for later.'
    : '';
  const preamble =
    options.preamble ||
    'You are codeMode, an Endo code-mode agent. You solve tasks by writing JavaScript and calling the evaluate tool.';
  const toolGuidance = options.preserveTools
    ? 'You have the evaluate tool plus the other active Pi tools. Use the tool best suited to each task; use evaluate for Endo capabilities.'
    : 'You have exactly one tool: evaluate. Do not call any other tool and do not answer in prose when a tool call can do the work.';
  const workspaceGuidance = normalized.some(
    global => global.name === 'workspace',
  )
    ? 'The `workspace` binding is the workspace root itself; do not call `workspace.root()`. For path arguments, an array is a sequence of segments and a string is one segment. The `workspace.entry()` exception accepts a slash-joined string when you intentionally need an entry for a nested path.'
    : 'Only the lexical bindings listed below are available; do not assume a workspace, Git, mount, remote, or introduced capability exists unless it is declared below.';
  return `${preamble}

${toolGuidance}

The evaluate tool evaluates JavaScript source in an Endo Compartment. The compartment includes hardened SES globals plus the powers listed below. These powers are already in lexical scope; do not look them up by pet name. The TypeScript declarations below are your primary reference: use them to pick a method and its arguments before your first call rather than probing at runtime. They may be a subset of a capability's live surface, so if you need a method that is not declared, discover it with E(capability).__getMethodNames__().

${workspaceGuidance}

Use E(capability).method(...) for remotable capabilities. Top-level await is not available, so use an async IIFE when you need multiple awaits or a final awaited result:

\`\`\`js
(async () => {
  const value = await E(example).method();
  return value;
})()
\`\`\`

Return the desired value as the source completion value.${resultNameGuidance}

Available powers:

\`\`\`ts
declare const E;
${formatGlobalDeclarations(normalized)}
\`\`\`
`;
};
harden(makeCodeModeSystemPrompt);

const IDENTIFIER_RE = /^[A-Za-z_$][0-9A-Za-z_$]*$/;

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
 * @param {LookupPowers | undefined} powers
 * @param {string | string[]} petName
 * @param {string} label
 * @returns {Promise<PowerHandle>}
 */
const lookupRequiredPower = (powers, petName, label) => {
  if (powers === undefined || powers === null) {
    throw new Error(`code-mode ${label} capability requires powers`);
  }
  return E(powers).lookup(petName);
};

/**
 * Posture validation and grant minting for the `workspace` and `git`
 * capabilities are synchronous: the same-vat instance testers recognize a
 * live Filesystem or Git facet, and an unsettled `E(powers).lookup()` promise
 * is neither. Rather than silently minting a grant whose declaration
 * describes a capability nobody has inspected, refuse the unresolved form and
 * point the caller at the asynchronous entry point that resolves first.
 *
 * @param {LookupPowers | undefined} lookupPowers
 * @param {string} label
 * @returns {never}
 */
const rejectUnresolvedPower = (lookupPowers, label) => {
  if (lookupPowers === undefined || lookupPowers === null) {
    throw new Error(`code-mode ${label} capability requires powers`);
  }
  throw new Error(
    `code-mode ${label} capability must be resolved before posture validation; use makeCodeModeAgentFromLookup (or resolveCodeModePowers) for a lookup-backed ${label} power`,
  );
};

/**
 * @param {string} name
 * @param {CodeModePower} capability
 * @param {'mount' | 'filesystem' | undefined} surface
 * @returns {CodeModeGlobal}
 */
const deriveFilesystemGlobal = (name, capability, surface) => {
  const posture = isFilesystemReadOnly(capability)
    ? 'readOnly'
    : isFilesystemReadWrite(capability)
      ? 'readWrite'
      : undefined;
  const isMount = lineageOf(capability) !== undefined;
  if (
    (surface === 'filesystem' && posture === undefined) ||
    (surface === 'mount' && !isMount) ||
    (surface === undefined && posture === undefined && !isMount)
  ) {
    throw new Error(
      `code-mode filesystem global "${name}" requires a locally recognized exact reader or writer posture; foreign filesystem capabilities are rejected`,
    );
  }
  return surface === 'filesystem' ||
    (surface === undefined && posture !== undefined)
    ? makeFilesystemGlobal({ name, readOnly: posture === 'readOnly' })
    : makeWorkspaceGlobal({ name });
};
harden(deriveFilesystemGlobal);

/**
 * @param {string} name
 * @param {CodeModePower} capability
 * @param {'readOnly' | 'readWrite' | 'historyRewrite' | undefined} requestedMode
 * @returns {CodeModeGlobal}
 */
const deriveGitGlobal = (name, capability, requestedMode) => {
  const readOnly = isGitReadOnly(capability);
  const historyRewrite = isGitHistoryRewrite(capability);
  if (readOnly === undefined || historyRewrite === undefined) {
    throw new Error(
      'code-mode Git global requires a recognized same-vat Git capability; foreign or unknown Git objects are rejected',
    );
  }
  const actualMode = historyRewrite
    ? 'historyRewrite'
    : readOnly
      ? 'readOnly'
      : 'readWrite';
  if (requestedMode !== undefined && requestedMode !== actualMode) {
    if (requestedMode === 'readOnly') {
      throw new Error(
        'code-mode gitMode readOnly requires an already read-only Git capability',
      );
    }
    if (requestedMode === 'historyRewrite') {
      throw new Error(
        'code-mode gitMode historyRewrite requires a Git capability with history-rewrite authority',
      );
    }
    throw new Error(
      `code-mode gitMode ${requestedMode} does not match the recognized Git capability posture (${actualMode})`,
    );
  }
  return makeGitGlobal({
    name,
    readOnly: actualMode === 'readOnly',
    historyRewrite: actualMode === 'historyRewrite',
  });
};
harden(deriveGitGlobal);

/**
 * @param {CodeModePowers} powers
 * @param {LookupPowers | undefined} lookupPowers
 * @param {Record<string, unknown>} baseEndowments
 * @param {CodeModeGlobal[] | undefined} suppliedGlobals
 * @returns {CodeModeGlobal[]}
 */
const makeCodeModeGlobals = (
  powers,
  lookupPowers,
  baseEndowments,
  suppliedGlobals,
) => {
  /** @type {CodeModeGlobal[]} */
  const globals = [
    ...(powers.workspace !== undefined || powers.workspacePetName !== undefined
      ? [
          {
            name: petNameToBindingName(
              powers.workspacePetName ?? 'workspace',
              'workspace',
            ),
          },
        ]
      : []),
    ...(powers.git !== undefined || powers.gitPetName !== undefined
      ? [
          {
            name: petNameToBindingName(powers.gitPetName ?? 'git', 'git'),
          },
        ]
      : []),
    ...(powers.namedPowers || []).map(({ name, petName }) => ({
      name,
      ...(petName === undefined ? {} : { petName }),
    })),
    ...Object.keys(baseEndowments).map(name => ({ name })),
  ];
  // Detect binding collisions before posture derivation can report a less
  // useful capability-shape error for the first duplicate.
  normalizeGlobals(globals);
  if (powers.workspace !== undefined || powers.workspacePetName !== undefined) {
    const petName = powers.workspacePetName ?? 'workspace';
    const name = petNameToBindingName(petName, 'workspace');
    globals.splice(
      globals.findIndex(global => global.name === name),
      1,
      deriveFilesystemGlobal(
        name,
        powers.workspace ?? rejectUnresolvedPower(lookupPowers, 'workspace'),
        powers.workspaceSurface,
      ),
    );
  }
  if (powers.git !== undefined || powers.gitPetName !== undefined) {
    const petName = powers.gitPetName ?? 'git';
    const name = petNameToBindingName(petName, 'git');
    globals.splice(
      globals.findIndex(global => global.name === name),
      1,
      deriveGitGlobal(
        name,
        powers.git ?? rejectUnresolvedPower(lookupPowers, 'git'),
        powers.gitMode,
      ),
    );
  }

  for (const [name, capability] of Object.entries(baseEndowments)) {
    if (name === 'E') {
      throw new Error('code-mode endowments may not replace the reserved E');
    }
    if (
      (typeof capability === 'object' && capability !== null) ||
      typeof capability === 'function'
    ) {
      const derivedIndex = globals.findIndex(global => global.name === name);
      const derived = globals[derivedIndex];
      if (derived?.declaration === undefined && derivedIndex >= 0) {
        const recognized = (() => {
          try {
            return deriveFilesystemGlobal(
              name,
              /** @type {CodeModePower} */ (capability),
              undefined,
            );
          } catch {
            try {
              return deriveGitGlobal(
                name,
                /** @type {CodeModePower} */ (capability),
                undefined,
              );
            } catch {
              return undefined;
            }
          }
        })();
        if (recognized !== undefined) {
          globals.splice(derivedIndex, 1, recognized);
        } else {
          const supplied = suppliedGlobals?.find(
            global => global.name === name,
          );
          if (supplied?.declaration !== undefined) {
            throw new Error(
              `code-mode endowment "${name}" cannot claim a declaration without a recognized capability posture`,
            );
          }
          if (supplied !== undefined) {
            globals.splice(derivedIndex, 1, {
              name,
              ...(supplied.petName === undefined
                ? {}
                : { petName: supplied.petName }),
              ...(supplied.description === undefined
                ? {}
                : { description: supplied.description }),
            });
          }
        }
      }
    }
  }

  const normalized = normalizeGlobals(
    powers.workspace === undefined &&
      powers.git === undefined &&
      (powers.namedPowers?.length ?? 0) === 0 &&
      Object.values(baseEndowments).every(
        value =>
          (typeof value !== 'object' || value === null) &&
          typeof value !== 'function',
      ) &&
      suppliedGlobals !== undefined
      ? suppliedGlobals
      : globals,
  );
  if (
    suppliedGlobals !== undefined &&
    (powers.workspace !== undefined ||
      powers.git !== undefined ||
      (powers.namedPowers?.length ?? 0) > 0 ||
      Object.keys(baseEndowments).length > 0)
  ) {
    const supplied = normalizeGlobals(suppliedGlobals);
    if (JSON.stringify(supplied) !== JSON.stringify(normalized)) {
      throw new Error(
        'code-mode globals must be derived from live capability posture',
      );
    }
  }
  return normalized;
};
harden(makeCodeModeGlobals);

/**
 * @param {CodeModePowers} powers
 * @param {Record<string, unknown>} baseEndowments
 * @param {LookupPowers | undefined} lookupPowers
 * @returns {Record<string, unknown>}
 */
const makeCodeModeEndowments = (powers, baseEndowments, lookupPowers) => {
  /** @type {Record<string, unknown>} */
  const endowments = { E, ...baseEndowments };
  if (powers.workspace !== undefined) {
    endowments[
      petNameToBindingName(powers.workspacePetName ?? 'workspace', 'workspace')
    ] = powers.workspace;
  }
  if (powers.git !== undefined) {
    endowments[petNameToBindingName(powers.gitPetName ?? 'git', 'git')] =
      powers.git;
  }
  for (const namedPower of powers.namedPowers || []) {
    endowments[namedPower.name] = lookupRequiredPower(
      lookupPowers,
      namedPower.petName || namedPower.name,
      namedPower.name,
    );
  }
  return harden(endowments);
};

/**
 * Construct a live code-mode agent: an agent whose sole tool is `evaluate`,
 * which evaluates JavaScript in a Compartment endowed with the configured
 * lexical powers. This is the code-mode preset of {@link defineAgent}; there is
 * no separate `define*` wrapper. The powerless definition is `defineAgent`'s
 * closure; supplying powers here is the powered stage.
 *
 * @param {MakeCodeModeAgentOptions} options
 * @returns {{ agent: Agent, globals: CodeModeGlobal[], evaluate: Evaluate, systemPrompt: string, model: Model<string> }}
 */
export const makeCodeModeAgent = options => {
  const {
    model,
    powers = {},
    lookupPowers,
    credentials = makeEnvCredentials(getAmbientEnv()),
    endowments: baseEndowments = {},
    storeValue,
    onContainedEventualSendRejection,
    messages,
    streamFn,
    getApiKey,
    thinkingLevel,
    preamble,
  } = options;

  const globals = makeCodeModeGlobals(
    powers,
    lookupPowers,
    baseEndowments,
    options.globals,
  );
  if (
    options.evaluate !== undefined &&
    onContainedEventualSendRejection !== undefined
  ) {
    throw new Error(
      'code-mode onContainedEventualSendRejection has no effect with a custom evaluate; the containment wrapper lives in makeCompartmentEvaluate, which a custom evaluate bypasses',
    );
  }

  const evaluate =
    options.evaluate ||
    makeCompartmentEvaluate({
      endowments: makeCodeModeEndowments(powers, baseEndowments, lookupPowers),
      storeValue,
      onContainedEventualSendRejection,
    });
  const evaluateWithStore =
    /** @type {Evaluate & { hasStoreValue?: boolean }} */ (evaluate);
  const hasStoreValue =
    storeValue !== undefined || evaluateWithStore.hasStoreValue === true;
  const systemPrompt = makeCodeModeSystemPrompt(globals, {
    preamble,
    storeValue: hasStoreValue,
  });
  const tool = makeEvaluateTool(
    evaluate,
    globals,
    hasStoreValue ? storeValue || true : undefined,
  );

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
  // pi-agent-core instance that mutates its own run state (e.g. `activeRun`)
  // while driving a conversation, so deep-freezing it would break the loop.
  return { agent, globals, evaluate, systemPrompt, model };
};
harden(makeCodeModeAgent);

/**
 * Resolve the lookup-backed `workspace` and `git` capabilities of a code-mode
 * powers record into inline capabilities, so that the synchronous posture
 * validation in {@link makeCodeModeAgent} inspects the live
 * capability rather than the promise for it.
 *
 * Named powers remain lookup-backed and are described as `unknown` globals.
 *
 * @param {CodeModePowers} [powers]
 * @param {LookupPowers} [lookupPowers]
 * @returns {Promise<CodeModePowers>}
 */
export const resolveCodeModePowers = async (powers, lookupPowers) => {
  if (powers === undefined) {
    return harden({});
  }
  const workspacePetName =
    powers.workspace === undefined ? powers.workspacePetName : undefined;
  const gitPetName = powers.git === undefined ? powers.gitPetName : undefined;
  if (workspacePetName === undefined && gitPetName === undefined) {
    return powers;
  }
  const [workspace, git] = await Promise.all([
    workspacePetName === undefined
      ? undefined
      : lookupRequiredPower(lookupPowers, workspacePetName, 'workspace'),
    gitPetName === undefined
      ? undefined
      : lookupRequiredPower(lookupPowers, gitPetName, 'git'),
  ]);
  return harden({
    ...powers,
    ...(workspace === undefined ? {} : { workspace }),
    ...(git === undefined ? {} : { git }),
  });
};
harden(resolveCodeModePowers);

/**
 * The asynchronous form of {@link makeCodeModeAgent}: resolve any
 * lookup-backed `workspace` and `git` capabilities first, then construct the
 * agent through the same synchronous validation boundary.
 *
 * @param {MakeCodeModeAgentOptions} options
 * @returns {Promise<{ agent: Agent, globals: CodeModeGlobal[], evaluate: Evaluate, systemPrompt: string, model: Model<string> }>}
 */
export const makeCodeModeAgentFromLookup = async options => {
  const powers = await resolveCodeModePowers(
    options.powers,
    options.lookupPowers,
  );
  return makeCodeModeAgent({ ...options, powers });
};
harden(makeCodeModeAgentFromLookup);

/**
 * The git-loop preset: a thin alias over {@link makeCodeModeAgent} that wires a
 * repository `workspace` Filesystem and a `git` capability as the lexical
 * powers and supplies the repository-oriented preamble. Returns the live
 * `Agent`.
 *
 * @param {GitLoopOptions} options
 * @returns {Agent}
 */
export const makeCodeModeGitLoopAgent = options => {
  const { workspace, git, readOnlyGit = false } = options;
  const { agent } = makeCodeModeAgent({
    model: options.model,
    powers: {
      workspace,
      git,
      ...(readOnlyGit ? { gitMode: 'readOnly' } : {}),
    },
    endowments: options.endowments,
    globals: options.globals,
    // A caller-supplied system prompt is the trusted preamble; the
    // repository-oriented default applies only when none is supplied.
    preamble:
      options.systemPrompt ??
      'You are an Endo-hosted Pi coding agent. Use the evaluate tool to inspect and edit the repository through the workspace Filesystem and Git capabilities.',
    evaluate: options.evaluate,
    storeValue: options.storeValue,
    onContainedEventualSendRejection: options.onContainedEventualSendRejection,
    messages: options.messages,
    streamFn: options.streamFn,
    getApiKey: options.getApiKey,
    thinkingLevel: options.thinkingLevel,
  });
  return agent;
};
harden(makeCodeModeGitLoopAgent);
