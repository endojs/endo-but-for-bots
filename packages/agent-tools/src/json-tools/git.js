// @ts-check
/// <reference types="ses"/>

/** @import { ERef } from '@endo/eventual-send' */
/** @import { InterfaceGuard, InterfaceGuardPayload, Pattern } from '@endo/patterns' */
/**
 * @import {
 *   GitHistoryToolCapability,
 *   GitToolFacet,
 *   GitToolReaderCapability,
 *   GitToolRewriterCapability,
 *   GitToolWriterCapability,
 *   ToolRecord,
 * } from '../types.js'
 */

/** @typedef {Record<keyof GitToolRewriterCapability, (...args: unknown[]) => Promise<unknown>>} GitToolDispatch */

import { E } from '@endo/eventual-send';
import {
  getInterfaceGuardPayload,
  getMethodGuardPayload,
} from '@endo/patterns';
import {
  GIT_READER_METHODS,
  GIT_REWRITER_METHODS,
  GIT_WRITER_METHODS,
  GitReaderInterface,
  GitRewriterInterface,
  GitWriterInterface,
} from '@endo/exo-git/src/interfaces.js';

import { makeTool } from '../tool.js';

/**
 * JSON Schemas for the Git methods exposed as agent tools. Methods that return
 * live capabilities are excluded; runtime arg guards come from the
 * corresponding facet interface.
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

const PATHS_PROP = harden({
  type: 'array',
  items: { type: 'string' },
  description:
    'Worktree-relative paths. Each path is resolved by the Git capability ' +
    'through its own confined mount; directory paths include everything ' +
    'under that directory. The worktree root itself is not a path designator.',
});

const CONFLICT_SIDE_PROP = harden({
  type: 'string',
  enum: ['ours', 'theirs'],
  description:
    'The unmerged Git index stage to select for every path: "ours" is ' +
    'stage 2 and "theirs" is stage 3. These names identify index stages, ' +
    'not stable branch roles. During rebase, Git treats the upstream onto ' +
    'which commits are replayed as ours and the commit being replayed as ' +
    'theirs, inverted from intuitive current/incoming branch wording.',
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
  description: 'Start a new rebase onto an upstream ref.',
  properties: {
    mode: { const: 'start', description: 'Start a new rebase.' },
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

const REBASE_INPUT_PROP = harden({
  description:
    'Choose one rebase action. Use "start" with upstream and optional ' +
    'autosquash; use "continue", "abort", or "skip" without those fields ' +
    'to control a rebase already in progress. If start or continue stops ' +
    'for conflicts, inspect status, resolve and stage the conflicts, then ' +
    'continue, skip the stopped commit, or abort the rebase.',
  oneOf: [
    REBASE_START_INPUT_PROP,
    {
      type: 'object',
      description:
        'Continue a stopped rebase after all conflicts have been resolved and staged.',
      properties: {
        mode: {
          const: 'continue',
          description: 'Continue the rebase already in progress.',
        },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    {
      type: 'object',
      description:
        'Abort the rebase and restore the branch and worktree to their pre-rebase state.',
      properties: {
        mode: {
          const: 'abort',
          description: 'Abort the rebase already in progress.',
        },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    {
      type: 'object',
      description:
        'Skip the stopped commit and continue replaying the remaining commits.',
      properties: {
        mode: {
          const: 'skip',
          description: 'Skip the current commit in the rebase.',
        },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  ],
});

const REBASE_DESCRIPTION =
  'Manage a rebase with mode "start" (upstream required, autosquash ' +
  'optional), "continue", "abort", or "skip". If start or continue stops ' +
  'for conflicts, inspect status, resolve and stage each conflict, then ' +
  'continue; use skip to omit the stopped commit or abort to restore the ' +
  'pre-rebase state.';

/**
 * This package intentionally exposes only a curated JSON-safe writable Git
 * slice for now.
 *
 * Holds the schemas for every facet's tool at once; `gitToolMethodsByFacet`
 * below projects this onto the method names each facet actually advertises,
 * so a method's schema is authored once regardless of how many facets carry
 * it.
 *
 * @type {Record<keyof GitToolRewriterCapability, { description: string, parameters: object }>}
 */
const gitToolSchemas = harden({
  add: {
    description:
      'Stage files or directories for the next commit by worktree-relative ' +
      'path. Staging is additive and never discards working-tree changes.',
    parameters: {
      type: 'object',
      properties: { paths: PATHS_PROP },
      required: ['paths'],
      additionalProperties: false,
    },
  },
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
  checkoutConflict: {
    description:
      'Resolve conflicted paths by selecting Git index stage 2 ("ours") ' +
      'or stage 3 ("theirs"), then stage the resolution. These are index ' +
      'stages, not stable branch roles: during rebase, ours is the upstream ' +
      'side and theirs is the commit being replayed, inverted from ' +
      'intuitive current/incoming wording. Fails on a path whose selected ' +
      'side has no version — a delete/modify conflict, where that side ' +
      'deleted the file — or a path that is not actually unmerged; resolve ' +
      'those by picking the surviving side or removing the path. Paths are ' +
      'processed left to right, so on failure the earlier paths are already ' +
      'staged and the error names the path that stopped it.',
    parameters: {
      type: 'object',
      properties: { paths: PATHS_PROP, side: CONFLICT_SIDE_PROP },
      required: ['paths', 'side'],
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
    description: REBASE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        input: REBASE_INPUT_PROP,
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
  trackingStatus: {
    description:
      'Report the current branch, upstream, and ahead/behind tracking counts.',
    parameters: NO_ARGS,
  },
});

/**
 * The writer facet's `commit` schema, narrower than both
 * `gitToolSchemas.commit` and the writer facet's own runtime guard: it
 * declares only `message` and omits `options` entirely. This is a deliberate
 * narrowing, not a match. The runtime guard (`GIT_METHOD_GUARDS.commitReadWrite`)
 * still accepts an optional options record so long as it does not set
 * `amend: true` — `options: {}` and `options: { amend: false }` both pass — so
 * the schema is a strict subset of what the guard admits. Advertising
 * `options.amend` at this facet would be a prompt-surface lie — the very
 * divergence this catalog derivation exists to close — and there is no
 * writer-facet use for the remaining commit options, so the schema simply
 * declines to offer `options` at all. The narrowing is safe (every input the
 * schema admits the guard also admits), but note it is invisible to
 * `divergence.test.js`, which derives candidate inputs only from
 * schema-declared property names and so structurally cannot flag a guard that
 * is wider than its schema. Only `commit` needs a per-facet schema override:
 * every other writer-tier method's schema is identical to its rewriter-tier
 * entry in `gitToolSchemas`.
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
 * (`add`, `checkoutConflict`, `commit`, `createBranch`, `switchBranch`) survive
 * only for `writer` and `rewriter`. A reader facet's projection is
 * read/navigation verbs only.
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
 * The fixed compatibility inventory promised by `makeGitHistoryTool`.
 * Its membership and order are public API, while every schema, description,
 * and positional guard is projected from the canonical rewriter catalog
 * below.
 *
 * @type {(keyof GitHistoryToolCapability)[]}
 */
const gitHistoryToolMethods = harden([
  'commit',
  'reword',
  'cherryPick',
  'rebase',
]);

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
 * from the supplied interface guard. `getMethodGuardPayload` unwraps the
 * `M.callWhen` await-arg wrappers. Reading from the facet's own interface
 * is what makes `commit`'s guard argument-sensitive per facet: a writer
 * facet's `commit` guard
 * excludes `amend: true` (`GIT_METHOD_GUARDS.commitReadWrite`), while a
 * rewriter facet's admits it.
 *
 * @param {string} method
 * @param {InterfaceGuard} gitInterface
 * @returns {Pattern[]}
 */
const positionalArgGuards = (method, gitInterface) => {
  const { methodGuards } = /** @type {InterfaceGuardPayload} */ (
    getInterfaceGuardPayload(gitInterface)
  );
  const { argGuards, optionalArgGuards } = getMethodGuardPayload(
    methodGuards[method],
  );
  return harden([...argGuards, ...(optionalArgGuards || [])]);
};

/**
 * Build agent-tool records for a live `Git` capability.
 *
 * @param {ERef<GitHistoryToolCapability | GitToolReaderCapability | GitToolWriterCapability | GitToolRewriterCapability>} gitCap
 *   A live `Git` capability. The exo `Git` cap is reached by dynamic method
 *   name through `E`, so this records only the invocation shape this maker
 *   needs.
 * @param {(keyof GitToolDispatch)[]} methods
 * @param {Partial<Record<keyof GitToolDispatch, { description: string, parameters: object }>>} schemas
 * @param {InterfaceGuard} gitInterface The facet interface `methods` was
 *   projected from, used to derive each positional argument guard.
 * @param {import('../types.js').ToolResultPolicy | undefined} resultPolicy
 *   Model-result presentation policy forwarded to every record.
 * @returns {ToolRecord[]}
 */
const makeGitTools = (gitCap, methods, schemas, gitInterface, resultPolicy) => {
  const records = methods.map(method => {
    const schema = /** @type {{ description: string, parameters: object }} */ (
      schemas[method]
    );
    const argGuards = positionalArgGuards(method, gitInterface);
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
      resultPolicy,
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
 * edit verbs (`add`, `checkoutConflict`, `commit`, `createBranch`,
 * `switchBranch`), and `'rewriter'`
 * additionally adds the history-rewrite verbs (`reword`, `cherryPick`,
 * `rebase`, and `commit`'s `amend` option). The runtime authority asserts in
 * `GitInterface` stay as defense in depth regardless of facet — a capability
 * without the matching authority still rejects the call — but the catalog
 * itself no longer advertises verbs the granted facet cannot perform.
 *
 * @overload
 * @param {ERef<GitToolReaderCapability>} gitCap
 * @param {{ facet: 'reader', resultPolicy?: import('../types.js').ToolResultPolicy }} options
 * @returns {ToolRecord[]}
 */
/**
 * @overload
 * @param {ERef<GitToolWriterCapability>} gitCap
 * @param {{ facet?: 'writer', resultPolicy?: import('../types.js').ToolResultPolicy }} [options]
 * @returns {ToolRecord[]}
 */
/**
 * @overload
 * @param {ERef<GitToolRewriterCapability>} gitCap
 * @param {{ facet: 'rewriter', resultPolicy?: import('../types.js').ToolResultPolicy }} options
 * @returns {ToolRecord[]}
 */
/**
 * @param {ERef<GitToolReaderCapability | GitToolWriterCapability | GitToolRewriterCapability>} gitCap
 * @param {{ facet?: GitToolFacet, resultPolicy?: import('../types.js').ToolResultPolicy }} [options]
 * @returns {ToolRecord[]}
 */
export const makeGitTool = (
  gitCap,
  { facet = 'writer', resultPolicy } = {},
) => {
  const methods = gitToolMethodsByFacet[facet];
  if (methods === undefined) {
    throw new Error(`makeGitTool: unknown facet ${JSON.stringify(facet)}`);
  }
  return makeGitTools(
    gitCap,
    methods,
    gitToolSchemasByFacet[facet],
    gitToolInterfaceByFacet[facet],
    resultPolicy,
  );
};
harden(makeGitTool);

/**
 * Build the historical four-tool history-rewrite inventory.
 *
 * @deprecated Prefer `makeGitTool(gitCap, { facet: 'rewriter' })` for the
 *   complete facet-derived catalog. This compatibility maker intentionally
 *   retains only `commit`, `reword`, `cherryPick`, and `rebase`, in that
 *   order, while sharing their canonical rewriter schemas and guards.
 *
 * @param {ERef<GitHistoryToolCapability>} gitCap
 * @param {{ resultPolicy?: import('../types.js').ToolResultPolicy }} [options]
 * @returns {ToolRecord[]}
 */
export const makeGitHistoryTool = (gitCap, { resultPolicy } = {}) =>
  makeGitTools(
    gitCap,
    gitHistoryToolMethods,
    gitToolSchemas,
    /** @type {InterfaceGuard} */ (GitRewriterInterface),
    resultPolicy,
  );
harden(makeGitHistoryTool);
