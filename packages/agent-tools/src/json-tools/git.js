// @ts-check
/// <reference types="ses"/>

/** @import { ERef } from '@endo/eventual-send' */
/** @import { InterfaceGuard, InterfaceGuardPayload, Pattern } from '@endo/patterns' */
/**
 * @import {
 *   GitHistoryToolCapability,
 *   GitToolCapability,
 *   GitToolFacet,
 *   GitToolReaderCapability,
 *   GitToolRewriterCapability,
 *   GitToolWriterCapability,
 *   ToolRecord,
 * } from '../types.js'
 */

/** @typedef {Record<keyof GitToolRewriterCapability | keyof GitHistoryToolCapability, (...args: unknown[]) => Promise<unknown>>} GitToolDispatch */

import { E } from '@endo/eventual-send';
import {
  getInterfaceGuardPayload,
  getMethodGuardPayload,
  M,
} from '@endo/patterns';
import { GitInterface } from '@endo/exo-git';
import {
  GIT_READER_METHODS,
  GIT_REWRITER_METHODS,
  GIT_WRITER_METHODS,
  GitReaderInterface,
  GitRebaseStartInputShape,
  GitRewriterInterface,
  GitWriterInterface,
} from '@endo/exo-git/src/interfaces.js';

import { makeTool } from '../tool.js';

/**
 * JSON Schemas for the Git methods exposed as agent tools. Methods that need
 * remotable arguments or return live capabilities are excluded; runtime arg
 * guards come from `GitInterface`.
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

// `RefArgShape = M.or(M.string(), GitRefShape)`.
const REF_PROP = harden({
  anyOf: [
    { type: 'string' },
    {
      type: 'object',
      properties: {
        name: { type: 'string' },
        kind: { enum: ['branch', 'tag', 'commit', 'detached'] },
        oid: { type: 'string' },
      },
      required: ['name', 'kind'],
      additionalProperties: false,
    },
  ],
  description:
    'A git ref: either a ref string (branch/tag/commit/"HEAD") or a ' +
    'structured ref record.',
});

const COMMIT_OPTIONS_PROP = harden({
  type: 'object',
  properties: {
    amend: {
      type: 'boolean',
      description: 'Amend HEAD instead of creating a new commit.',
    },
  },
  required: [],
  additionalProperties: false,
});

const COMMIT_PROP = harden({
  type: 'string',
  description: 'The commit message.',
});

const CHERRY_PICK_OPTIONS_PROP = harden({
  type: 'object',
  properties: {
    noCommit: {
      type: 'boolean',
      description:
        'Apply the patch to the index and worktree without committing.',
    },
  },
  required: [],
  additionalProperties: false,
});

const REBASE_START_INPUT_PROP = harden({
  type: 'object',
  properties: {
    mode: { const: 'start' },
    upstream: {
      type: 'string',
      description: 'The upstream ref to replay the current branch onto.',
    },
    autosquash: {
      type: 'boolean',
      description: 'Fold fixup!/squash! commits during the replay.',
    },
  },
  required: ['mode', 'upstream'],
  additionalProperties: false,
});

/**
 * This package intentionally exposes only a curated JSON-safe writable Git slice
 * for now. Methods that remotely accept capabilities or can return
 * capabilities, including non-empty `status()` rows, need capref/result
 * serialization and are deferred future work.
 *
 * Holds the schemas for every facet's tool at once; `gitToolMethodsByFacet`
 * below projects this onto the method names each facet actually advertises,
 * so a method's schema is authored once regardless of how many facets carry
 * it.
 *
 * @type {Record<keyof GitToolRewriterCapability, { description: string, parameters: object }>}
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
    description: 'Record staged changes, or amend HEAD when requested.',
    parameters: {
      type: 'object',
      properties: {
        message: COMMIT_PROP,
        options: COMMIT_OPTIONS_PROP,
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  reword: {
    description: 'Replace a commit message while keeping its patch unchanged.',
    parameters: {
      type: 'object',
      properties: {
        ref: REF_PROP,
        message: { type: 'string', description: 'The replacement message.' },
      },
      required: ['ref', 'message'],
      additionalProperties: false,
    },
  },
  cherryPick: {
    description: 'Replay an existing commit onto the current branch.',
    parameters: {
      type: 'object',
      properties: {
        ref: REF_PROP,
        options: CHERRY_PICK_OPTIONS_PROP,
      },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  rebase: {
    description: 'Replay the current branch onto an upstream ref.',
    parameters: {
      type: 'object',
      properties: {
        input: REBASE_START_INPUT_PROP,
      },
      required: ['input'],
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
 * The writer facet's `commit` schema, narrower than `gitToolSchemas.commit`:
 * no `options` property at all, matching the writer facet's runtime guard
 * (`GIT_METHOD_GUARDS.commitReadWrite`), which rejects `amend: true`. A
 * schema that still advertised `options.amend` at this facet would be a
 * prompt-surface lie — the very divergence this catalog derivation exists to
 * close. Only `commit` needs a per-facet schema override: every other
 * writer-tier method's schema is identical to its rewriter-tier entry in
 * `gitToolSchemas`.
 *
 * @type {{ description: string, parameters: object }}
 */
const WRITER_COMMIT_SCHEMA = harden({
  description: 'Record the staged changes as a new commit.',
  parameters: harden({
    type: 'object',
    properties: { message: COMMIT_PROP },
    required: ['message'],
    additionalProperties: false,
  }),
});

/** @type {Record<keyof GitHistoryToolCapability, { description: string, parameters: object }>} */
const gitHistoryToolSchemas = harden({
  commit: {
    description: 'Record staged changes, or amend HEAD when requested.',
    parameters: {
      type: 'object',
      properties: {
        message: COMMIT_PROP,
        options: COMMIT_OPTIONS_PROP,
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  reword: {
    description: 'Replace a commit message while keeping its patch unchanged.',
    parameters: {
      type: 'object',
      properties: {
        ref: REF_PROP,
        message: { type: 'string', description: 'The replacement message.' },
      },
      required: ['ref', 'message'],
      additionalProperties: false,
    },
  },
  cherryPick: {
    description: 'Replay an existing commit onto the current branch.',
    parameters: {
      type: 'object',
      properties: { ref: REF_PROP, options: CHERRY_PICK_OPTIONS_PROP },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  rebase: {
    description: 'Replay the current branch onto an upstream ref.',
    parameters: {
      type: 'object',
      properties: { input: REBASE_START_INPUT_PROP },
      required: ['input'],
      additionalProperties: false,
    },
  },
});

/**
 * The full, cumulative schema catalog in fixed declaration order. Every
 * facet's advertised method list is a filter of this order, never an
 * independently maintained array, so adding a method here is the one edit
 * that reaches whichever facets actually carry it.
 *
 * @type {(keyof GitToolRewriterCapability)[]}
 */
const gitToolMethods = harden(
  /** @type {(keyof GitToolRewriterCapability)[]} */ (
    Object.keys(gitToolSchemas)
  ),
);

/** @type {(keyof GitHistoryToolCapability)[]} */
const gitHistoryToolMethods = harden(
  /** @type {(keyof GitHistoryToolCapability)[]} */ (
    Object.keys(gitHistoryToolSchemas)
  ),
);

/**
 * The three cumulative facet interfaces `makeGitTool` derives its catalog
 * from, keyed the same way `@endo/exo-git`'s `makeGitKit` names its facets.
 *
 * @type {Record<GitToolFacet, InterfaceGuard>}
 */
const gitToolInterfaceByFacet = harden({
  reader: /** @type {InterfaceGuard} */ (GitReaderInterface),
  writer: /** @type {InterfaceGuard} */ (GitWriterInterface),
  rewriter: /** @type {InterfaceGuard} */ (GitRewriterInterface),
});

/**
 * Facet membership, exported by `@endo/exo-git` as the single source of
 * truth for which methods each cumulative facet carries (reader within
 * writer within rewriter). Filtering `gitToolMethods` against these
 * memberships — rather than hand-listing a method array per facet — is the
 * derivation: a method's tool-catalog presence per facet always matches its
 * actual runtime authority, because both read the same membership lists.
 *
 * @type {Record<GitToolFacet, readonly string[]>}
 */
const gitFacetMethodMembership = harden({
  reader: GIT_READER_METHODS,
  writer: GIT_WRITER_METHODS,
  rewriter: GIT_REWRITER_METHODS,
});

/**
 * `gitToolMethods`, projected per facet: rewrite verbs (`reword`,
 * `cherryPick`, `rebase`) survive the filter only for `rewriter`; edit verbs
 * (`commit`, `createBranch`, `switchBranch`) survive only for `writer` and
 * `rewriter`. A reader facet's projection is read/navigation verbs only.
 *
 * @type {Record<GitToolFacet, (keyof GitToolRewriterCapability)[]>}
 */
const gitToolMethodsByFacet = harden(
  /** @type {Record<GitToolFacet, (keyof GitToolRewriterCapability)[]>} */ (
    Object.fromEntries(
      /** @type {GitToolFacet[]} */ (Object.keys(gitToolInterfaceByFacet)).map(
        facet => [
          facet,
          harden(
            gitToolMethods.filter(method =>
              gitFacetMethodMembership[facet].includes(method),
            ),
          ),
        ],
      ),
    )
  ),
);

/**
 * `gitToolSchemas`, projected per facet with `commit` swapped for
 * {@link WRITER_COMMIT_SCHEMA} at every facet below `rewriter`, so the
 * advertised schema never offers an `amend` option a facet's runtime guard
 * would reject.
 *
 * @type {Record<GitToolFacet, Record<keyof GitToolRewriterCapability, { description: string, parameters: object }>>}
 */
const gitToolSchemasByFacet = harden(
  /** @type {Record<GitToolFacet, Record<keyof GitToolRewriterCapability, { description: string, parameters: object }>>} */ (
    Object.fromEntries(
      /** @type {GitToolFacet[]} */ (Object.keys(gitToolInterfaceByFacet)).map(
        facet => [
          facet,
          facet === 'rewriter'
            ? gitToolSchemas
            : harden({ ...gitToolSchemas, commit: WRITER_COMMIT_SCHEMA }),
        ],
      ),
    )
  ),
);

/**
 * Positional arg guards for a method, required first and then optional, read
 * off the supplied interface guard. `getMethodGuardPayload` unwraps the
 * `M.callWhen` await-arg wrappers. Reading from the facet's own interface
 * (rather than always the flat `GitInterface`) is what makes `commit`'s
 * guard argument-sensitive per facet: a writer facet's `commit` guard
 * excludes `amend: true` (`GIT_METHOD_GUARDS.commitReadWrite`), while a
 * rewriter facet's admits it.
 *
 * @param {string} method
 * @param {InterfaceGuard} [gitInterface]
 * @returns {Pattern[]}
 */
const positionalArgGuards = (method, gitInterface = GitInterface) => {
  const { methodGuards } = /** @type {InterfaceGuardPayload} */ (
    getInterfaceGuardPayload(gitInterface)
  );
  const { argGuards, optionalArgGuards } = getMethodGuardPayload(
    methodGuards[method],
  );
  return harden([...argGuards, ...(optionalArgGuards || [])]);
};

/**
 * Per-facet arg-guard overrides. `rebase`'s JSON tool only ever exposes the
 * `mode: "start"` case (continue/abort/skip are out of scope for this
 * slice), narrower than the exo interface's `GitRebaseInputShape`, so every
 * facet whose method list carries `rebase` needs the `GitRebaseStartInputShape`
 * intersection layered onto that facet's own positional guard.
 *
 * @type {Record<GitToolFacet, Partial<Record<keyof GitToolRewriterCapability, Pattern[]>>>}
 */
const gitToolArgGuardsByFacet = harden(
  /** @type {Record<GitToolFacet, Partial<Record<keyof GitToolRewriterCapability, Pattern[]>>>} */ (
    Object.fromEntries(
      /** @type {GitToolFacet[]} */ (Object.keys(gitToolInterfaceByFacet)).map(
        facet => [
          facet,
          harden(
            gitToolMethodsByFacet[facet].includes('rebase')
              ? {
                  rebase: harden([
                    M.and(
                      positionalArgGuards(
                        'rebase',
                        gitToolInterfaceByFacet[facet],
                      )[0],
                      GitRebaseStartInputShape,
                    ),
                  ]),
                }
              : {},
          ),
        ],
      ),
    )
  ),
);

/** @type {Partial<Record<keyof GitHistoryToolCapability, Pattern[]>>} */
const gitHistoryToolArgGuards = harden({
  rebase: harden([
    M.and(positionalArgGuards('rebase')[0], GitRebaseStartInputShape),
  ]),
});

/**
 * Build agent-tool records for a live `Git` capability.
 *
 * @param {ERef<GitToolReaderCapability | GitToolWriterCapability | GitToolRewriterCapability | GitHistoryToolCapability>} gitCap
 *   A live `Git` capability. The exo `Git` cap is reached by dynamic method
 *   name through `E`, so this records only the invocation shape this maker
 *   needs.
 * @param {(keyof GitToolDispatch)[]} methods
 * @param {Partial<Record<keyof GitToolDispatch, { description: string, parameters: object }>>} schemas
 * @param {InterfaceGuard} gitInterface The facet interface `methods` was
 *   projected from, used to derive any arg guard not present in
 *   `argGuardsByMethod`.
 * @param {Partial<Record<keyof GitToolDispatch, Pattern[]>>} argGuardsByMethod
 * @returns {ToolRecord[]}
 */
const makeGitTools = (
  gitCap,
  methods,
  schemas,
  gitInterface,
  argGuardsByMethod = {},
) => {
  const records = methods.map(method => {
    const schema = /** @type {{ description: string, parameters: object }} */ (
      schemas[method]
    );
    const argGuards =
      argGuardsByMethod[method] || positionalArgGuards(method, gitInterface);
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
      argGuards,
      execute: async argsRecord => {
        // Marshal named args back to positional order by declared name.
        const positional = paramNames.map(paramName => argsRecord[paramName]);
        while (
          positional.length > 0 &&
          positional[positional.length - 1] === undefined
        ) {
          positional.pop();
        }
        const gitMethod = /** @type {keyof GitToolDispatch} */ (method);
        const git = /** @type {GitToolDispatch} */ (E(gitCap));
        return git[gitMethod](...positional);
      },
    });
  });
  return harden(records);
};

/**
 * Build the default attenuated agent-tool records for a live `Git`
 * capability, catalog derived from the granted facet: `facet: 'reader'`
 * advertises read/navigation verbs only, `'writer'` (the default, matching
 * the authority `provideGit` grants without `allowHistoryRewrite`) adds the
 * edit verbs (`commit`, `createBranch`, `switchBranch`), and `'rewriter'`
 * additionally adds the history-rewrite verbs (`reword`, `cherryPick`,
 * `rebase`, and `commit`'s `amend` option). The runtime authority asserts in
 * `GitInterface` stay as defense in depth regardless of facet — a capability
 * without the matching authority still rejects the call — but the catalog
 * itself no longer advertises verbs the granted facet cannot perform.
 *
 * @overload
 * @param {ERef<GitToolReaderCapability>} gitCap
 * @param {{ facet: 'reader' }} options
 * @returns {ToolRecord[]}
 */
/**
 * @overload
 * @param {ERef<GitToolWriterCapability>} gitCap
 * @param {{ facet?: 'writer' }} [options]
 * @returns {ToolRecord[]}
 */
/**
 * @overload
 * @param {ERef<GitToolRewriterCapability>} gitCap
 * @param {{ facet: 'rewriter' }} options
 * @returns {ToolRecord[]}
 */
/**
 * @param {ERef<GitToolReaderCapability | GitToolWriterCapability | GitToolRewriterCapability>} gitCap
 * @param {{ facet?: GitToolFacet }} [options]
 * @returns {ToolRecord[]}
 */
export const makeGitTool = (gitCap, { facet = 'writer' } = {}) => {
  const methods = gitToolMethodsByFacet[facet];
  if (methods === undefined) {
    throw new Error(`makeGitTool: unknown facet ${JSON.stringify(facet)}`);
  }
  return makeGitTools(
    gitCap,
    methods,
    gitToolSchemasByFacet[facet],
    gitToolInterfaceByFacet[facet],
    gitToolArgGuardsByFacet[facet],
  );
};
harden(makeGitTool);

/**
 * Build explicitly elevated history-rewrite tool records for a live `Git`
 * capability.
 * Hosts must opt in to exposing these operations to a model.
 *
 * @param {ERef<GitHistoryToolCapability>} gitCap
 * @returns {ToolRecord[]}
 */
export const makeGitHistoryTool = gitCap =>
  makeGitTools(
    gitCap,
    gitHistoryToolMethods,
    gitHistoryToolSchemas,
    /** @type {InterfaceGuard} */ (GitInterface),
    gitHistoryToolArgGuards,
  );
harden(makeGitHistoryTool);
