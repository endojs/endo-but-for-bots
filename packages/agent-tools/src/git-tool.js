// @ts-check
/// <reference types="ses"/>

/** @import { ERef } from '@endo/eventual-send' */
/** @import { InterfaceGuard, Pattern } from '@endo/patterns' */
/** @import { GitStatusToolEntry, GitToolCapability, ToolRecord } from './types.js' */

/** @typedef {Record<keyof GitToolCapability, (...args: unknown[]) => Promise<unknown>>} GitToolDispatch */

import { E } from '@endo/eventual-send';
import {
  getInterfaceGuardPayload,
  getMethodGuardPayload,
  M,
} from '@endo/patterns';
import { GitInterface } from '@endo/exo-git';

import { makeTool } from './tool.js';

/**
 * JSON Schemas for the Git methods exposed as agent tools. Methods that need
 * remotable arguments or return live capabilities are excluded; runtime arg
 * guards come from `GitInterface` where the tool shape mirrors the Git method
 * shape. Rebase and merge remain out of scope for this curated slice: those
 * workflows require additional policy around conflict and history handling.
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

const PATHS_PROP = harden({
  type: 'array',
  items: { type: 'string' },
  description: 'Repo-relative paths to stage.',
});

/**
 * This package intentionally exposes only a curated JSON-safe `EndoGit` slice
 * for now. Methods that remotely accept capabilities or can return
 * capabilities need capref/result serialization and are deferred future work.
 * `status()` is exposed by projecting only JSON-safe row fields, and `add()`
 * accepts repo-relative path strings that are resolved against those status
 * rows before calling the underlying capability-bearing Git method.
 *
 * @type {Record<keyof GitToolCapability, { description: string, parameters: object }>}
 */
const gitToolSchemas = harden({
  log: {
    description: 'List commit history, most recent first.',
    parameters: {
      type: 'object',
      properties: { options: OPTIONS_PROP },
      required: [],
      additionalProperties: false,
    },
  },
  diff: {
    description: 'Show changes between commits, the index, and the worktree.',
    parameters: {
      type: 'object',
      properties: { options: OPTIONS_PROP },
      required: [],
      additionalProperties: false,
    },
  },
  status: {
    description:
      'List changed paths with JSON-safe index and worktree state only.',
    parameters: NO_ARGS,
  },
  add: {
    description:
      'Stage changed files by repo-relative path, resolving paths through git status.',
    parameters: {
      type: 'object',
      properties: { paths: PATHS_PROP },
      required: ['paths'],
      additionalProperties: false,
    },
  },
  show: {
    description: 'Show the contents of a git object (commit, tag, blob).',
    parameters: {
      type: 'object',
      properties: { ref: REF_PROP },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  commit: {
    description: 'Record the staged changes as a new commit.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The commit message.' },
      },
      required: ['message'],
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
        name: { type: 'string', description: 'The new branch name.' },
        options: OPTIONS_PROP,
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  switchBranch: {
    description: 'Switch the working tree to an existing branch.',
    parameters: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'The branch to switch to.' },
      },
      required: ['branch'],
      additionalProperties: false,
    },
  },
  currentBranch: {
    description:
      'Report the currently checked-out branch (or nothing when detached).',
    parameters: NO_ARGS,
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
 * @param {Record<string, unknown>} argsRecord
 * @param {string} toolName
 */
const assertNoArgs = (argsRecord, toolName) => {
  const keys = Object.keys(argsRecord);
  if (keys.length > 0) {
    throw new Error(`unexpected ${toolName} argument key "${keys[0]}"`);
  }
};

/**
 * @param {Record<string, unknown>} argsRecord
 * @returns {string[]}
 */
const getPathArgs = argsRecord => {
  const { paths } = /** @type {{ paths?: unknown }} */ (argsRecord);
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('git add requires a non-empty paths array');
  }
  for (const path of paths) {
    if (typeof path !== 'string' || path === '') {
      throw new Error('git add paths must be non-empty strings');
    }
  }
  return harden([...paths]);
};

/**
 * @param {unknown} row
 * @returns {GitStatusToolEntry}
 */
const sanitizeStatusRow = row => {
  const { path, index, worktree, renamedFrom } =
    /** @type {{ path: string, index: string, worktree: string, renamedFrom?: string }} */ (
      row
    );
  const indexStatus = /** @type {GitStatusToolEntry['index']} */ (
    /** @type {unknown} */ (index)
  );
  const worktreeStatus = /** @type {GitStatusToolEntry['worktree']} */ (
    /** @type {unknown} */ (worktree)
  );
  return harden({
    path,
    index: indexStatus,
    worktree: worktreeStatus,
    ...(renamedFrom !== undefined ? { renamedFrom } : {}),
  });
};

/**
 * Resolve repo-relative paths to the entry capabilities already minted by the
 * granted Git capability's status rows. This lets the tool present a JSON-safe
 * path API without acquiring any filesystem authority beyond `gitCap`.
 *
 * @param {GitToolDispatch} git
 * @param {string[]} paths
 * @returns {Promise<object[]>}
 */
const statusEntriesForPaths = async (git, paths) => {
  const rawRows = await git.status();
  const rows = /** @type {{ path: string, entry: object }[]} */ (rawRows);
  const byPath = new Map(rows.map(row => [row.path, row]));
  const entries = [];
  for (const path of paths) {
    const row = byPath.get(path);
    if (row === undefined) {
      throw new Error(`git add path is not present in status: ${path}`);
    }
    entries.push(row.entry);
  }
  return harden(entries);
};

/**
 * @param {GitToolDispatch} git
 * @param {Record<string, unknown>} argsRecord
 */
const executeStatus = async (git, argsRecord) => {
  assertNoArgs(argsRecord, 'status');
  const rawRows = await git.status();
  const rows = /** @type {unknown[]} */ (rawRows);
  return harden(rows.map(sanitizeStatusRow));
};

/**
 * @param {GitToolDispatch} git
 * @param {Record<string, unknown>} argsRecord
 */
const executeAdd = async (git, argsRecord) => {
  const paths = getPathArgs(argsRecord);
  const entries = await statusEntriesForPaths(git, paths);
  return git.add(entries);
};

/**
 * Build agent-tool records for a live `Git` capability.
 *
 * @param {ERef<GitToolCapability>} gitCap
 *   A live `Git` capability. The exo `Git` cap is reached by dynamic method
 *   name through `E`, so this records only the invocation shape this maker
 *   needs.
 * @returns {ToolRecord[]}
 */
export const makeGitTool = gitCap => {
  const records = gitToolMethods.map(method => {
    const schema = gitToolSchemas[method];
    const argGuards = positionalArgGuards(method);
    // The schema's declared property order is the positional argument order,
    // matching the convention `makeTool` applies to the named-args record.
    const paramNames = Object.keys(
      /** @type {{ properties?: Record<string, unknown> }} */ (
        schema.parameters
      ).properties || {},
    );
    return makeTool({
      name: method,
      description: schema.description,
      parameters: schema.parameters,
      argGuards: method === 'add' ? harden([M.arrayOf(M.string())]) : argGuards,
      execute: argsRecord => {
        const gitMethod = /** @type {keyof GitToolCapability} */ (method);
        const git = /** @type {GitToolDispatch} */ (E(gitCap));
        if (method === 'status') {
          return executeStatus(git, argsRecord);
        }
        if (method === 'add') {
          return executeAdd(git, argsRecord);
        }
        // Marshal named args back to positional order by declared name.
        const positional = paramNames.map(paramName => argsRecord[paramName]);
        while (
          positional.length > 0 &&
          positional[positional.length - 1] === undefined
        ) {
          positional.pop();
        }
        return git[gitMethod](...positional);
      },
    });
  });
  return harden(records);
};
harden(makeGitTool);
