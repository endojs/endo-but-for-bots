// @ts-check
/// <reference types="ses"/>

/** @import { ERef } from '@endo/far' */
/** @import { Filesystem } from '@endo/endo-fs' */
/** @import { ToolPowers, ToolRecord } from './types.js' */

/**
 * North-star tool-API contract — Phase 1 stubs.
 *
 * These factories define the *intended* signatures and the petname-binding
 * contract for the agent-tools surface the north-star loop drives end to end
 * (see `test/north-star-loop.test.js`). Every body throws `not implemented:
 * <tool>` so the contract compiles and type-checks today while the follow-on
 * builds make `test/north-star-loop.test.js` go green tool by tool. Nothing
 * here implements real behavior.
 *
 * Two boundary shapes recur and are named once here:
 *
 * - **Argument-side wire-ify** (already implemented in `tool.js` `resolveArg`):
 *   an LLM passes a petname *string*; the invoke boundary resolves it to a live
 *   cap via `E(powers).lookup(petname)` before the tool body runs. The `add`
 *   tool (which already exists on this branch via `makeGitTool`) is the live
 *   example the loop reuses.
 * - **Return-side wire-ify** (the new direction these stubs introduce): a tool
 *   that *returns* live caps (a `status` row's `EndoMountEntry`, a
 *   `filesystemAt` `Filesystem`) cannot hand an LLM a live object. It binds
 *   each returned cap under a petname in the guest's own directory via
 *   `E(powers).storeValue(cap, petname)` and returns the *petname* in the
 *   plain-JSON result. The agent then names that petname in a later
 *   capref-taking tool (`add`), closing the loop. `storeValue` is the inverse
 *   of the `lookup` that argument-side resolution uses; the two together let a
 *   cap make a full round-trip through an LLM that only ever sees strings.
 *
 * The unblocking these stubs target: `git-tool.js` deferred the Git methods
 * that *return* live caps (`status`, `filesystemAt`) precisely because no
 * return-side-wire-ify shape existed yet. Naming `storeValue(cap, petname)` as
 * the return-side call is what lets those methods join the tool surface.
 */

/**
 * @param {string} tool
 * @returns {never}
 */
const notImplemented = tool => {
  throw new Error(`not implemented: ${tool}`);
};

/**
 * Filesystem **edit** tool: write (create or overwrite) a UTF-8 text file at a
 * root-relative path through a writable `EndoMount` / endo-fs `Filesystem`.
 * The mirror-image write counterpart to `makeMountReadTool`'s read-one-file.
 *
 * Contract:
 * - Tool name `mountWriteText`.
 * - Parameters `{ path: string, content: string }`, both required, no extras.
 * - Resolves `path` to a `File` through the mount (minting intermediate
 *   directories is out of scope for the loop; the loop edits a path whose
 *   parent already exists), opens it `{ write: true }`, and writes the UTF-8
 *   bytes of `content`, truncating any prior contents.
 * - Returns a plain-JSON ack (e.g. `{ path, bytesWritten }`) — never a live cap.
 * - Rejects a `../` escape structurally (the `Filesystem` enforces it, as in
 *   `makeMountReadTool`), not via a string check.
 *
 * @param {ERef<Filesystem>} fs A writable `@endo/endo-fs` `Filesystem` ERef
 *   (the daemon `EndoMount`'s worktree view).
 * @returns {ToolRecord}
 */
export const makeMountWriteTool = fs => {
  void fs;
  return harden({
    name: 'mountWriteText',
    description:
      'Write a UTF-8 text file into the mounted project directory, ' +
      'creating or overwriting it. Path is mount-relative; "../" escapes ' +
      'are rejected.',
    parameters: harden({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Mount-relative path to the file to write.',
        },
        content: {
          type: 'string',
          description: 'UTF-8 text to write, replacing any prior contents.',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    }),
    inputSchema: harden({
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    }),
    invoke: async _args => notImplemented('mountWriteText'),
  });
};
harden(makeMountWriteTool);

/**
 * Filesystem **list** tool: enumerate the entry names directly under a
 * root-relative directory path through an endo-fs `Filesystem`.
 *
 * Contract:
 * - Tool name `mountList`.
 * - Parameters `{ path?: string }` (absent / `''` lists the root), no extras.
 * - Resolves the directory through the mount and returns a plain-JSON
 *   `{ entries: string[] }` of single-segment child names in directory order.
 *   Names only — never live `Directory` / `File` caps.
 *
 * @param {ERef<Filesystem>} fs An `@endo/endo-fs` `Filesystem` ERef.
 * @returns {ToolRecord}
 */
export const makeMountListTool = fs => {
  void fs;
  return harden({
    name: 'mountList',
    description:
      'List the entry names directly under a directory in the mounted ' +
      'project directory. Path is mount-relative; absent lists the root.',
    parameters: harden({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Mount-relative directory path; absent lists the root.',
        },
      },
      required: [],
      additionalProperties: false,
    }),
    inputSchema: harden({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: [],
      additionalProperties: false,
    }),
    invoke: async _args => notImplemented('mountList'),
  });
};
harden(makeMountListTool);

/**
 * Filesystem **stat** tool: report metadata for one root-relative path through
 * an endo-fs `Filesystem`.
 *
 * Contract:
 * - Tool name `mountStat`.
 * - Parameters `{ path: string }`, required, no extras.
 * - Resolves the entry through the mount and returns a plain-JSON record
 *   (e.g. `{ path, type: 'file' | 'directory', size? }`) drawn from the entry's
 *   qid / stat. Never a live cap.
 *
 * @param {ERef<Filesystem>} fs An `@endo/endo-fs` `Filesystem` ERef.
 * @returns {ToolRecord}
 */
export const makeMountStatTool = fs => {
  void fs;
  return harden({
    name: 'mountStat',
    description:
      'Report metadata (type, size) for one path in the mounted project ' +
      'directory. Path is mount-relative.',
    parameters: harden({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Mount-relative path to stat.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    }),
    inputSchema: harden({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    }),
    invoke: async _args => notImplemented('mountStat'),
  });
};
harden(makeMountStatTool);

/**
 * Git **status** tool: report the worktree status as plain-JSON rows AND bind
 * each changed entry's live `EndoMountEntry` cap to a petname in the guest's
 * own directory so the agent can name it in a later capref-taking tool.
 *
 * This is the return-side-wire-ify direction `git-tool.js` deferred. The Git
 * exo's `status()` mints an `EndoMountEntry` per row (`r.entry`); an LLM cannot
 * hold that live cap, so the tool binds it under a petname and returns the
 * petname in the row.
 *
 * Contract:
 * - Tool name `status`.
 * - No parameters.
 * - Calls `E(gitCap).status()`, then for each returned row binds its `entry`
 *   cap under a deterministic petname via the return-side-wire-ify call
 *   **`E(powers).storeValue(row.entry, petname)`** (the inverse of the
 *   `E(powers).lookup(petname)` that `tool.js` `resolveArg` uses on the
 *   argument side). The petname is derived from the row's `path` so the agent
 *   can correlate it (e.g. slugified `path`); collisions across calls overwrite,
 *   which is the intended "latest status binds the name" semantics.
 * - Returns plain JSON only: `{ rows: Array<{ path, index, worktree, petname,
 *   renamedFrom? }> }`. The `index` / `worktree` status codes pass through
 *   verbatim; `petname` is the name the agent then passes to `add`. No live cap
 *   is ever placed in the JSON.
 * - Requires `powers` (it binds names); a tool built without `powers` throws a
 *   clear error when invoked, matching the `add`-without-powers contract.
 *
 * @param {ERef<import('./types.js').GitToolCapability & {
 *   status: () => Promise<Array<Record<string, unknown>>>,
 * }>} gitCap A live daemon-minted `Git` capability whose `status()` mints
 *   `EndoMountEntry` caps per row.
 * @param {ERef<ToolPowers & {
 *   storeValue: (value: unknown, petName: string | string[]) => Promise<void>,
 * }>} powers The guest directory the tool binds returned caps into and that
 *   capref args later resolve against. Required.
 * @returns {ToolRecord}
 */
export const makeGitStatusTool = (gitCap, powers) => {
  void gitCap;
  void powers;
  return harden({
    name: 'status',
    description:
      'Report the working-tree status as JSON rows and bind each changed ' +
      "entry to a petname in the agent's directory so it can be named in a " +
      'later add/restore call.',
    parameters: harden({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    }),
    inputSchema: harden({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    }),
    invoke: async _args => notImplemented('status'),
  });
};
harden(makeGitStatusTool);

/**
 * Git **remote** tool set: the bounded fetch / pull / push surface over a live
 * `GitRemote` cap (`@endo/exo-git` `makeGitRemote`). The `GitRemote` already
 * enforces direction / refspec / credential policy; this tool is the thin
 * agent-facing adapter that exposes its three verbs.
 *
 * Contract — one record per verb, names `gitFetch` / `gitPull` / `gitPush`:
 * - Each takes an options record passed straight through to the matching
 *   `E(gitRemote).<verb>(options)` method (`{ prune?, tags? }` for fetch,
 *   `{ branch?, strategy? }` for pull, `{ source?, destination?, force?,
 *   setUpstream? }` for push). All options are optional.
 * - Returns the `GitRemote` operation result as plain JSON (the audit-friendly
 *   `{ updatedRefs?, integration?, head? }` shape the remote already produces);
 *   no live cap crosses back.
 * - The tool grants no authority the bound `GitRemote` does not already permit:
 *   a fetch-only remote rejects `gitPush` at the `GitRemote` boundary, surfaced
 *   verbatim.
 *
 * @param {ERef<{
 *   fetch: (options?: object) => Promise<unknown>,
 *   pull: (options?: object) => Promise<unknown>,
 *   push: (options?: object) => Promise<unknown>,
 * }>} gitRemote A live, policy-bound `GitRemote` cap.
 * @returns {ToolRecord[]}
 */
export const makeGitRemoteTool = gitRemote => {
  void gitRemote;
  const optionsParam = harden({
    type: 'object',
    properties: {
      options: {
        type: 'object',
        description:
          'Options record passed through to the bounded GitRemote verb.',
      },
    },
    required: [],
    additionalProperties: false,
  });
  /**
   * @param {string} name
   * @param {string} description
   * @returns {ToolRecord}
   */
  const makeRemoteVerb = (name, description) =>
    harden({
      name,
      description,
      parameters: optionsParam,
      inputSchema: optionsParam,
      invoke: async _args => notImplemented(name),
    });
  return harden([
    makeRemoteVerb(
      'gitFetch',
      'Fetch from the bounded remote (policy-limited refspecs).',
    ),
    makeRemoteVerb(
      'gitPull',
      'Fetch and integrate from the bounded remote (ff-only by default).',
    ),
    makeRemoteVerb(
      'gitPush',
      'Push to the bounded remote (policy-limited refspecs).',
    ),
  ]);
};
harden(makeGitRemoteTool);

/**
 * Git **filesystemAt** tool: open a read-only filesystem view of any git ref
 * (e.g. `HEAD~1`, a branch name, a remote-tracking ref) and bind the resulting
 * `Filesystem` cap to a petname so the agent can read historical file versions
 * through a read tool over that view.
 *
 * This is the second return-side-wire-ify case `git-tool.js` deferred: the Git
 * exo's `filesystemAt(ref)` returns a live read-only `Filesystem` cap, which an
 * LLM cannot hold.
 *
 * Contract:
 * - Tool name `filesystemAt`.
 * - Parameters `{ ref: string }`, required, no extras (a ref string the backend
 *   resolves — `HEAD`, `HEAD~1`, a branch, a remote-tracking ref).
 * - Calls `E(gitCap).filesystemAt(ref)` to obtain the read-only `Filesystem`,
 *   then binds it under a petname via the same return-side-wire-ify call the
 *   status tool uses — **`E(powers).storeValue(filesystem, petname)`** — and
 *   returns plain JSON `{ ref, petname }`. The agent then constructs / drives an
 *   FS read tool (`makeMountReadTool`) over `lookup(petname)` to read the prior
 *   version of a file. No live cap is placed in the JSON.
 * - Requires `powers`; built without it, invoking throws a clear error.
 *
 * @param {ERef<{ filesystemAt: (ref: string) => Promise<unknown> }>} gitCap A
 *   live daemon-minted `Git` capability.
 * @param {ERef<ToolPowers & {
 *   storeValue: (value: unknown, petName: string | string[]) => Promise<void>,
 * }>} powers The guest directory the returned `Filesystem` is bound into.
 *   Required.
 * @returns {ToolRecord}
 */
export const makeGitFilesystemAtTool = (gitCap, powers) => {
  void gitCap;
  void powers;
  return harden({
    name: 'filesystemAt',
    description:
      'Open a read-only filesystem view of a git ref (HEAD~1, a branch, a ' +
      "remote-tracking ref) and bind it to a petname in the agent's " +
      'directory so its files can be read through a read tool.',
    parameters: harden({
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description:
            'A git ref to open read-only: "HEAD", "HEAD~1", a branch ' +
            'name, or a remote-tracking ref.',
        },
      },
      required: ['ref'],
      additionalProperties: false,
    }),
    inputSchema: harden({
      type: 'object',
      properties: { ref: { type: 'string' } },
      required: ['ref'],
      additionalProperties: false,
    }),
    invoke: async _args => notImplemented('filesystemAt'),
  });
};
harden(makeGitFilesystemAtTool);
