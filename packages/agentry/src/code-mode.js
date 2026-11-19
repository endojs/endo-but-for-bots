// @ts-check
/// <reference types="ses"/>

/** @import { Model } from '@earendil-works/pi-ai' */
/** @import { Agent, AgentMessage, StreamFn } from '@earendil-works/pi-agent-core' */
/** @import { Credentials, GetApiKey, ThinkingLevel } from './harness/types.js' */
/** @import { CodeModeGlobal, CodeModeGrant, CodeModePower, Evaluate, LookupPowers, PowerHandle, StoreValue } from '@endo/agent-tools/code-mode/types.js' */
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

import { defineAgent } from './define-agent.js';
import {
  codeModeGrantGlobals,
  makeCodeModeGrantMinter,
  normalizeCodeModeGrants,
} from './code-mode-grants.js';
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
  return `${preamble}

${toolGuidance}

The evaluate tool evaluates JavaScript source in an Endo Compartment. The compartment includes hardened SES globals plus the powers listed below. These powers are already in lexical scope; do not look them up by pet name. The TypeScript declarations below are your primary reference: use them to pick a method and its arguments before your first call rather than probing at runtime. They may be a subset of a capability's live surface, so if you need a method that is not declared, discover it with E(capability).__getMethodNames__().

The \`workspace\` binding is the workspace root itself; do not call \`workspace.root()\`. For path arguments, an array is a sequence of segments and a string is one segment. The \`workspace.entry()\` exception accepts a slash-joined string when you intentionally need an entry for a nested path.

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
 * @param {CodeModePowers} powers
 * @returns {CodeModeGlobal[]}
 */
const namedGrantsForCollision = powers =>
  (powers.grants || []).map(({ name }) => ({ name }));

/**
 * @param {Record<string, unknown>} baseEndowments
 * @param {CodeModeGlobal[] | undefined} legacyGlobals
 * @returns {CodeModeGlobal[]}
 */
const primitiveGlobalsFor = (baseEndowments, legacyGlobals) => {
  const globalsByName = new Map(
    (legacyGlobals || []).map(global => [global.name, global]),
  );
  return Object.entries(baseEndowments)
    .filter(
      ([, value]) =>
        (typeof value !== 'object' || value === null) &&
        typeof value !== 'function',
    )
    .map(([name]) => {
      const global = globalsByName.get(name);
      return {
        name,
        ...(global?.petName === undefined ? {} : { petName: global.petName }),
        ...(global?.description === undefined
          ? {}
          : { description: global.description }),
      };
    });
};
harden(primitiveGlobalsFor);

/**
 * @param {CodeModePowers} powers
 * @param {LookupPowers | undefined} lookupPowers
 * @param {Record<string, unknown>} baseEndowments
 * @param {CodeModeGlobal[] | undefined} legacyGlobals
 * @returns {CodeModeGrant[]}
 */
const makeCodeModeGrants = (
  powers,
  lookupPowers,
  baseEndowments,
  legacyGlobals,
) => {
  const minter = makeCodeModeGrantMinter();
  // Validate the complete lexical-name set before resolving capabilities so a
  // deterministic collision cannot be masked by a later posture check.
  /** @type {CodeModeGlobal[]} */
  const candidateGlobals = [
    ...namedGrantsForCollision(powers),
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
    ...(powers.namedPowers || []).map(({ name }) => ({ name })),
    ...Object.keys(baseEndowments).map(name => ({ name })),
  ];
  normalizeGlobals(candidateGlobals);
  /** @type {CodeModeGrant[]} */
  const grants = [];
  const namedGrants = powers.grants || [];
  grants.push(...normalizeCodeModeGrants(namedGrants));

  if (powers.workspace !== undefined || powers.workspacePetName !== undefined) {
    const petName = powers.workspacePetName ?? 'workspace';
    const name = petNameToBindingName(petName, 'workspace');
    grants.push(
      minter.filesystem({
        name,
        petName,
        surface: powers.workspaceSurface,
        capability:
          powers.workspace ?? rejectUnresolvedPower(lookupPowers, 'workspace'),
      }),
    );
  }
  if (powers.git !== undefined || powers.gitPetName !== undefined) {
    const petName = powers.gitPetName ?? 'git';
    const name = petNameToBindingName(petName, 'git');
    grants.push(
      minter.git({
        name,
        petName,
        requestedMode: powers.gitMode,
        capability: powers.git ?? rejectUnresolvedPower(lookupPowers, 'git'),
      }),
    );
  }

  for (const namedPower of powers.namedPowers || []) {
    if (Object.hasOwn(namedPower, 'capability')) {
      throw new Error(
        `code-mode named power "${namedPower.name}" cannot supply a capability-and-declaration pair; use a trusted grant minter`,
      );
    }
    if (namedPower.declaration !== undefined) {
      throw new Error(
        `code-mode named power "${namedPower.name}" cannot supply an unrecognized declaration`,
      );
    } else {
      const capability = lookupRequiredPower(
        lookupPowers,
        namedPower.petName || namedPower.name,
        namedPower.name,
      );
      // Legacy descriptors have no trusted declaration/capability pairing.
      // Preserve their lexical name and description, but intentionally reduce
      // the declaration to `unknown` at this adapter boundary.
      grants.push(
        minter.opaque({
          name: namedPower.name,
          petName: namedPower.petName,
          description: namedPower.description,
          capability,
        }),
      );
    }
  }

  const globalsByName = new Map(
    (legacyGlobals || []).map(global => [global.name, global]),
  );
  for (const [name, capability] of Object.entries(baseEndowments)) {
    if (name === 'E') {
      throw new Error('code-mode endowments may not replace the reserved E');
    }
    if (grants.some(grant => grant.name === name)) {
      throw new Error(
        `code-mode endowment "${name}" duplicates a capability grant`,
      );
    }
    const global = globalsByName.get(name);
    if (global?.declaration !== undefined) {
      throw new Error(
        `code-mode endowment "${name}" cannot pair an unrecognized capability with a declaration`,
      );
    }
    if (
      (typeof capability === 'object' && capability !== null) ||
      typeof capability === 'function'
    ) {
      grants.push(
        minter.opaque({
          name,
          petName: global?.petName,
          description: global?.description,
          capability: /** @type {CodeModePower} */ (capability),
        }),
      );
    }
  }

  const normalized = normalizeCodeModeGrants(grants);
  if (legacyGlobals !== undefined) {
    const normalizedLegacy = normalizeGlobals(legacyGlobals);
    const primitiveGlobals = primitiveGlobalsFor(baseEndowments, legacyGlobals);
    const derived = normalizeGlobals([
      ...codeModeGrantGlobals(normalized),
      ...primitiveGlobals,
    ]);
    if (
      normalizedLegacy.length !== derived.length ||
      normalizedLegacy.some((global, index) =>
        Object.keys(global).some(key => global[key] !== derived[index][key]),
      )
    ) {
      throw new Error(
        'code-mode globals must be derived from the live capability grants',
      );
    }
  }
  return normalized;
};
harden(makeCodeModeGrants);

/**
 * @param {CodeModeGrant[]} grants
 * @param {Record<string, unknown>} baseEndowments
 * @returns {Record<string, unknown>}
 */
const makeCodeModeEndowments = (grants, baseEndowments) => {
  /** @type {Record<string, unknown>} */
  const endowments = { E, ...baseEndowments };
  for (const grant of grants) {
    endowments[grant.name] = grant.capability;
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
 * @returns {{ agent: Agent, grants: CodeModeGrant[], globals: CodeModeGlobal[], evaluate: Evaluate, systemPrompt: string, model: Model<string> }}
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

  if (options.systemPrompt !== undefined) {
    throw new Error(
      'code-mode systemPrompt is derived from live capability grants; use preamble for trusted instructions',
    );
  }

  const grants = makeCodeModeGrants(
    powers,
    lookupPowers,
    baseEndowments,
    options.globals,
  );
  const primitiveGlobals = primitiveGlobalsFor(baseEndowments, options.globals);
  const globals = normalizeGlobals([
    ...codeModeGrantGlobals(grants),
    ...primitiveGlobals,
  ]);

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
      endowments: makeCodeModeEndowments(grants, baseEndowments),
      storeValue,
      onContainedEventualSendRejection,
    });
  const evaluateWithStore =
    /** @type {Evaluate & { hasStoreValue?: boolean }} */ (evaluate);
  const hasStoreValue =
    storeValue !== undefined || evaluateWithStore.hasStoreValue === true;
  const systemPrompt =
    options.systemPrompt ||
    makeCodeModeSystemPrompt(globals, { preamble, storeValue: hasStoreValue });
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
  return { agent, grants, globals, evaluate, systemPrompt, model };
};
harden(makeCodeModeAgent);

/**
 * Resolve the lookup-backed `workspace` and `git` capabilities of a code-mode
 * powers record into inline capabilities, so that the synchronous posture
 * validation and grant minting in {@link makeCodeModeAgent} inspect the live
 * capability rather than the promise for it.
 *
 * Named powers are intentionally left unresolved: they mint opaque `unknown`
 * grants that never consult a posture tester, so forcing a round trip for
 * them would only delay agent construction.
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
 * @returns {Promise<{ agent: Agent, grants: CodeModeGrant[], globals: CodeModeGlobal[], evaluate: Evaluate, systemPrompt: string, model: Model<string> }>}
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
  const {
    workspace,
    git,
    readOnlyGit = false,
    historyRewriteGit = false,
  } = options;
  const { agent } = makeCodeModeAgent({
    model: options.model,
    powers: {
      workspace,
      git,
      gitMode: readOnlyGit
        ? 'readOnly'
        : historyRewriteGit
          ? 'historyRewrite'
          : 'readWrite',
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
