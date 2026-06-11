// @ts-check
/// <reference types="ses"/>

/** @import { ERef } from '@endo/far' */
/** @import { InterfaceGuard, Pattern } from '@endo/patterns' */
/** @import { ArgKind, GitToolCapability, ToolPowers, ToolRecord } from './types.js' */

/** @typedef {Record<keyof GitToolCapability, (...args: unknown[]) => Promise<unknown>>} GitToolDispatch */

import { E } from '@endo/far';
import {
  getInterfaceGuardPayload,
  getMethodGuardPayload,
} from '@endo/patterns';
import { GitInterface } from '@endo/exo-git';

import { makeTool } from './tool.js';

/**
 * JSON Schemas for the Git methods exposed as agent tools. Methods that return
 * live capabilities (a non-empty `status()` row, `filesystemAt`) need
 * result serialization and stay deferred future work; the capability-*taking*
 * methods `add` and `restore` are in the slice — their `M.arrayOf(M.remotable())`
 * argument crosses the wire as a **petname-string array** that the `makeTool`
 * invoke boundary resolves to live caps through the guest petstore
 * (`E(powers).lookup`) before the guard runs. Runtime arg guards come from
 * `GitInterface`.
 */

const NO_ARGS = harden({
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
});

// `M.recordOf(M.string(), M.any())` → an open object.
const OPTIONS_PROP = harden({
  type: 'object',
  description: 'Options record passed through to the underlying git command.',
});

// `RefArgShape = M.or(M.string(), M.recordOf(M.string(), M.any()))`.
const REF_PROP = harden({
  anyOf: [{ type: 'string' }, { type: 'object' }],
  description:
    'A git ref: either a ref string (branch/tag/commit/"HEAD") or a ' +
    'structured ref record.',
});

// `M.arrayOf(M.remotable())` → an array of petname strings (the wire form an
// LLM passes). Each petname is resolved to a live cap via the guest petstore
// (`E(powers).lookup`) at the invoke boundary, before the `M.arrayOf(M.remotable())`
// guard runs. The advertised schema is a petname-string array — NOT an opaque
// `cap:<hex>` handle array and NOT `{type:'object'}` — because an LLM cannot put
// a live object in JSON; the only correct wire form is the friendly petname the
// host bound the entry under. `test/divergence.test.js` proves this
// petname-string schema agrees with the resolved-cap guard.
const PETNAME_ARRAY_PROP = harden({
  type: 'array',
  items: {
    type: 'string',
    description:
      'A petname naming a working-tree entry the host bound for this guest.',
  },
  description:
    'Working-tree entries to operate on, named by petname (resolved to live ' +
    'caps against the guest petstore before staging).',
});

/**
 * One descriptor per method in the slice: `parameters` is the hand-authored
 * JSON Schema and `description` the curated tool description; `argKinds` (when
 * present) hand-marks which positionals are caprefs (petname strings resolved
 * to live caps). The runtime `argGuards` are filled in from `GitInterface` by
 * `makeGitTool`. Hand-authoring `argKinds` (rather than deriving them) matches
 * the package's no-deriver stance; the divergence gate proves the petname-string
 * schema agrees with the resolved-cap guard.
 *
 * @type {Record<keyof GitToolCapability, { description: string, parameters: object, argKinds?: ArgKind[] }>}
 */
const gitToolSchemas = harden({
  log: {
    description: 'List commit history, most recent first.',
    parameters: {
      type: 'object',
      properties: { arg0: OPTIONS_PROP },
      required: [],
      additionalProperties: false,
    },
  },
  diff: {
    description: 'Show changes between commits, the index, and the worktree.',
    parameters: {
      type: 'object',
      properties: { arg0: OPTIONS_PROP },
      required: [],
      additionalProperties: false,
    },
  },
  show: {
    description: 'Show the contents of a git object (commit, tag, blob).',
    parameters: {
      type: 'object',
      properties: { arg0: REF_PROP },
      required: ['arg0'],
      additionalProperties: false,
    },
  },
  commit: {
    description: 'Record the staged changes as a new commit.',
    parameters: {
      type: 'object',
      properties: {
        arg0: { type: 'string', description: 'The commit message.' },
      },
      required: ['arg0'],
      additionalProperties: false,
    },
  },
  branches: {
    description: 'List the repository branches.',
    parameters: NO_ARGS,
  },
  createBranch: {
    description: 'Create a new branch.',
    parameters: {
      type: 'object',
      properties: {
        arg0: { type: 'string', description: 'The new branch name.' },
        arg1: OPTIONS_PROP,
      },
      required: ['arg0'],
      additionalProperties: false,
    },
  },
  switchBranch: {
    description: 'Switch the working tree to an existing branch.',
    parameters: {
      type: 'object',
      properties: {
        arg0: { type: 'string', description: 'The branch to switch to.' },
      },
      required: ['arg0'],
      additionalProperties: false,
    },
  },
  currentBranch: {
    description:
      'Report the currently checked-out branch (or nothing when detached).',
    parameters: NO_ARGS,
  },
  add: {
    description:
      'Stage one or more working-tree entries (named by petname) for the ' +
      'next commit.',
    parameters: {
      type: 'object',
      properties: { arg0: PETNAME_ARRAY_PROP },
      required: ['arg0'],
      additionalProperties: false,
    },
    // arg0 is an array of petnames, resolved to live caps before the guard.
    argKinds: ['capref[]'],
  },
  restore: {
    description:
      'Restore working-tree entries (named by petname) — unstage or discard ' +
      'changes.',
    parameters: {
      type: 'object',
      properties: { arg0: PETNAME_ARRAY_PROP, arg1: OPTIONS_PROP },
      required: ['arg0'],
      additionalProperties: false,
    },
    // arg0 is a petname array; arg1 (the options record) is a plain value and
    // defaults to 'value' via the short-argKinds rule in makeTool.
    argKinds: ['capref[]'],
  },
});

/**
 * @type {(keyof GitToolCapability)[]}
 */
const gitToolMethods = harden(
  /** @type {(keyof GitToolCapability)[]} */ (Object.keys(gitToolSchemas)),
);

/**
 * Positional arg guards for a method, required first and then optional.
 * `getMethodGuardPayload` unwraps the `M.callWhen` await-arg wrappers.
 *
 * @param {string} method
 * @returns {Pattern[]}
 */
const positionalArgGuards = method => {
  const { methodGuards } = getInterfaceGuardPayload(
    /** @type {InterfaceGuard} */ (GitInterface),
  );
  const { argGuards, optionalArgGuards } = getMethodGuardPayload(
    methodGuards[method],
  );
  return harden([...argGuards, ...(optionalArgGuards || [])]);
};

/**
 * Build agent-tool records for a live `Git` capability.
 *
 * @param {ERef<GitToolCapability>} gitCap
 *   A live `Git` capability. The exo `Git` cap is reached by dynamic method
 *   name through `E`, so this records only the invocation shape this maker
 *   needs.
 * @param {ERef<ToolPowers>} [powers]
 *   The guest authority capref resolution sends `lookup` to. Required only when
 *   a capref-taking tool (`add`/`restore`) is invoked; the non-capref methods
 *   ignore it. Threaded in once at tool-set construction (the `make(powers)`
 *   guest convention), never supplied by the LLM.
 * @returns {ToolRecord[]}
 */
export const makeGitTool = (gitCap, powers) => {
  const records = gitToolMethods.map(method => {
    const schema = gitToolSchemas[method];
    const argGuards = positionalArgGuards(method);
    return makeTool({
      name: method,
      description: schema.description,
      parameters: schema.parameters,
      argGuards,
      argKinds: schema.argKinds,
      powers,
      execute: async argsRecord => {
        // Marshal named args back to positional order.
        const positional = [];
        for (let i = 0; i < argGuards.length; i += 1) {
          positional.push(argsRecord[`arg${i}`]);
        }
        while (
          positional.length > 0 &&
          positional[positional.length - 1] === undefined
        ) {
          positional.pop();
        }
        const gitMethod = /** @type {keyof GitToolCapability} */ (method);
        const git = /** @type {GitToolDispatch} */ (E(gitCap));
        return git[gitMethod](...positional);
      },
    });
  });
  return harden(records);
};
harden(makeGitTool);
