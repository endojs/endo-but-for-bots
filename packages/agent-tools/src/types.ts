import type { ERef } from '@endo/eventual-send';
import type { Filesystem } from '@endo/platform/fs/extended';
import type {
  EndoGit,
  GitRef,
  GitRemote,
  HistoryRewriteEndoGit,
  ReadOnlyEndoGit,
  ReadWriteEndoGit,
  WritableGitWorktree,
} from '@endo/exo-git';
import type { EndoShell } from '@endo/exo-shell';
import type { HttpClient, HttpResponse } from '@endo/exo-http-client';
import type { Pattern } from '@endo/patterns';

/**
 * The three cumulative Git facets `makeGitTool` derives a catalog from,
 * named the same way `@endo/exo-git`'s `makeGitKit` names its facets
 * (reader within writer within rewriter).
 */
export type GitToolFacet = 'reader' | 'writer' | 'rewriter';

/** The read/navigation slice every facet's catalog carries. */
type GitToolReadMethodNames =
  | 'log'
  | 'diff'
  | 'show'
  | 'branches'
  | 'currentBranch';

/**
 * Adds the ordinary edit verbs a writer facet (and above) carries: `commit`
 * (additive only — a writer's `commit` guard excludes `amend: true`),
 * `createBranch`, `switchBranch`.
 */
type GitToolWriteMethodNames =
  | GitToolReadMethodNames
  | 'commit'
  | 'createBranch'
  | 'switchBranch';

/**
 * Adds the history-rewrite verbs only a rewriter facet carries: `reword`,
 * `cherryPick`, all four `rebase` modes (`start`, `continue`, `abort`, and
 * `skip`), and `commit`'s `amend` option.
 */
type GitToolRewriteMethodNames =
  | GitToolWriteMethodNames
  | 'reword'
  | 'cherryPick'
  | 'rebase';

/**
 * The read-only slice of the default git tool catalog: `makeGitTool(gitCap,
 * { facet: 'reader' })`. Deliberately omits every mutator; a reader facet
 * carries none.
 */
export type GitToolReaderCapability = Pick<
  ReadOnlyEndoGit,
  GitToolReadMethodNames
>;

/**
 * The read, branch-navigation, and additive-edit slice of `ReadWriteEndoGit`
 * that `makeGitTool` exposes by default (`facet: 'writer'`, or the `facet`
 * option omitted).
 *
 * Deliberately omits the destructive, non-history-rewrite methods —
 * `merge`, `restore`, `deleteBranch`, `renameBranch`, the `stash*` family, and
 * the working-tree/detach mutators (`switch`, `detach`). Those carry
 * authority a tool surface handed to a model should not advertise: they can
 * discard uncommitted work. `commit` (additive only), `createBranch`, and
 * `switchBranch` are included as the write surface the local git tool
 * intentionally grants at this tier; `reword`, `cherryPick`, `rebase`, and
 * `commit`'s `amend` option are held back for {@link GitToolRewriterCapability}
 * — the live `Git` capability handed to `makeGitTool` still enforces
 * `allowHistoryRewrite` at the runtime layer (see `GitInterface`) as defense
 * in depth, but the catalog itself no longer advertises verbs the granted
 * facet cannot perform.
 *
 * This slice holds only the JSON-transparent methods whose hand-authored tool
 * schemas map one-to-one onto their `GitInterface` guards (the divergence gate
 * pins that parity). The methods whose native signatures traffic in live
 * capabilities — `add` and `checkoutConflict` (arrays of mount-entry
 * remotables) — are served instead by {@link GitMountToolCapability} /
 * `makeGitMountTools`, which bridge path strings to entries through the
 * worktree mount. `status` remains in that bridge so its agent-facing default
 * can select collapsed untracked directories.
 */
export type GitToolWriterCapability = Pick<
  ReadWriteEndoGit,
  GitToolWriteMethodNames
>;

/**
 * The write-plus-history-rewrite slice of `HistoryRewriteEndoGit` that
 * `makeGitTool(gitCap, { facet: 'rewriter' })` exposes: everything
 * {@link GitToolWriterCapability} carries, plus `reword`, `cherryPick`, all
 * four `rebase` modes, and `commit`'s `amend` option. Granting this catalog is
 * a deliberate authority decision — call `makeGitTool` with `{ facet:
 * 'rewriter' }` only when the tool surface is meant to advertise history
 * rewrite.
 */
export type GitToolRewriterCapability = Pick<
  HistoryRewriteEndoGit,
  GitToolRewriteMethodNames
>;

/**
 * Back-compat alias for the default (`'writer'`) facet catalog `makeGitTool`
 * composes when its `facet` option is omitted, and the type
 * {@link WorkspaceGitCapability} composes over.
 */
export type GitToolCapability = GitToolWriterCapability;

/**
 * The narrow capability accepted by the compatibility history-tool maker.
 *
 * @deprecated Prefer {@link GitToolRewriterCapability} with `makeGitTool` for
 * the complete rewriter-facet catalog. This type intentionally retains the
 * four methods accepted by `makeGitHistoryTool` before facet-derived catalogs
 * were introduced.
 */
export type GitHistoryToolCapability = Pick<
  HistoryRewriteEndoGit,
  'commit' | 'reword' | 'cherryPick' | 'rebase'
>;

/**
 * The mount-bridged slice of `ReadWriteEndoGit` behind `makeGitMountTools`:
 * `status`, `add`, plus `worktree` (the mount the bridge mints `PathEntry`
 * values from). `add` and `checkoutConflict` take arrays of `PathEntry`
 * remotables, while `status` is kept here to apply the agent-facing
 * `untracked: 'normal'` default. `add` is the additive staging half of the
 * commit loop; `checkoutConflict` selects and stages one side of existing
 * unmerged entries.
 */
export type GitMountToolCapability = Pick<
  ReadWriteEndoGit,
  'status' | 'add' | 'checkoutConflict'
> & {
  /** The bridge mints lineage-bearing entries from the writable worktree. */
  worktree: () => Promise<WritableGitWorktree>;
};

/**
 * The push-tier slice of a `GitRemote` exposed to an LLM: `fetch`, `pull`, and
 * `push` (the network + credential layer, daemon-agent-tools § Phase 3), plus
 * the credential-free `inspect` that reports the remote's policy bounds. This
 * is the full guest-facing `GitRemote` surface; the policy-bearing
 * `GitRemoteController` (which mutates directions, refspecs, and revocation)
 * stays host-side and is never an agent-facing tool. A read-only `Git` cannot
 * construct a `GitRemote` at all, so the read tier structurally excludes push —
 * there is no attenuation to perform here, and this surface adds no authority
 * beyond what the granted `GitRemote` already carries.
 */
export type GitRemoteToolCapability = Pick<
  GitRemote,
  'inspect' | 'fetch' | 'pull' | 'push'
>;

export interface ToolSpec {
  /** Tool name advertised to callers. */
  name: string;
  /** One-line capability description. */
  description: string;
  /**
   * Hand-authored JSON Schema object. It is used verbatim as both the LLM tool
   * `parameters` and the MCP `inputSchema`.
   */
  parameters: object;
  /**
   * Optional array of `@endo/patterns` Patterns, one per positional argument,
   * used for a runtime `mustMatch` of each supplied argument before `execute`
   * runs.
   */
  argGuards?: Pattern[];
  /**
   * Dispatch target. Receives the named-args record keyed by the schema's
   * declared `parameters.properties` names (e.g. `{ message }`, `{ name,
   * options }`).
   */
  execute: (
    args: Record<string, unknown>,
    context?: ToolInvocationContext,
  ) => Promise<unknown>;
}

/** Host controls supplied alongside a tool invocation. */
export interface ToolInvocationContext {
  signal?: AbortSignal;
}

export interface ToolRecord {
  name: string;
  description: string;
  /** The JSON Schema used as LLM `parameters`. */
  parameters: object;
  /** The same JSON Schema used as MCP `inputSchema`. */
  inputSchema: object;
  /**
   * Validates the supplied args against `argGuards` when present, then calls
   * `execute(args)`.
   */
  invoke: (
    args: Record<string, unknown>,
    context?: ToolInvocationContext,
  ) => Promise<unknown>;
}

export declare function makeTool(spec: ToolSpec): ToolRecord;

/**
 * Build the default attenuated agent-tool records for a live `Git`
 * capability. The `facet` option pins which cumulative facet's catalog is
 * derived — `'reader'` for read/navigation verbs only, `'writer'` (the
 * default) additionally for `commit` / `createBranch` / `switchBranch`, and
 * `'rewriter'` additionally for `reword` / `cherryPick` / `rebase` and
 * `commit`'s `amend` option. The rebase tool supports `start`, `continue`,
 * `abort`, and `skip`. The `gitCap` type is pinned to match: passing a
 * capability narrower than the requested facet is a type error.
 */
export interface MakeGitTool {
  (
    gitCap: ERef<GitToolReaderCapability>,
    options: { facet: 'reader' },
  ): ToolRecord[];
  (
    gitCap: ERef<GitToolWriterCapability>,
    options?: { facet?: 'writer' },
  ): ToolRecord[];
  (
    gitCap: ERef<GitToolRewriterCapability>,
    options: { facet: 'rewriter' },
  ): ToolRecord[];
}

export declare const makeGitTool: MakeGitTool;

/**
 * @deprecated Prefer `makeGitTool(gitCap, { facet: 'rewriter' })` for the
 * complete rewriter-facet catalog. This maker retains the narrow four-tool
 * compatibility inventory.
 */
export declare function makeGitHistoryTool(
  gitCap: ERef<GitHistoryToolCapability>,
): ToolRecord[];

export declare function makeGitMountTools(
  gitCap: ERef<GitMountToolCapability>,
): ToolRecord[];

export declare function makeGitRemoteTool(
  remoteCap: ERef<GitRemoteToolCapability>,
): ToolRecord[];

/**
 * The slice of `EndoShell` exposed to an LLM: `exec` (allowlisted, argv-only
 * command execution) and `inspect` (report the policy bounds). The allowlist,
 * sanitized env, timeout, and output cap are all enforced inside the `Shell`
 * exo, so this surface adds no authority beyond what the capability already
 * carries.
 */
export type ShellToolCapability = Pick<EndoShell, 'exec' | 'inspect'>;

/** A command-string reject pattern; ported from the prior agent framework's command-tool policy. */
export type RejectPatternEntry = RegExp | { pattern: RegExp; reason?: string };

/** A forbidden-flag entry; ported from the prior agent framework's command-tool policy. */
export type RejectFlagEntry = string | { flag: string; reason?: string };

export interface ShellToolOptions {
  /**
   * Advisory command-string veto patterns applied in the tool layer before the
   * call reaches `Shell.exec`. Hardening advice, not the boundary.
   */
  rejectPatterns?: RejectPatternEntry[];
  /**
   * Advisory forbidden-flag entries applied in the tool layer before the call
   * reaches `Shell.exec`. Hardening advice, not the boundary.
   */
  rejectFlags?: RejectFlagEntry[];
}

export declare function makeShellTool(
  shellCap: ERef<ShellToolCapability>,
  options?: ShellToolOptions,
): ToolRecord[];

export interface MountReadToolOptions {
  /**
   * Maximum number of UTF-8 characters returned before truncation. Defaults to
   * 50,000. A value of `0` disables the limit and returns the full contents.
   */
  maxChars?: number;
}

export interface MountFsToolsOptions {
  /**
   * When `true`, omit the write (edit) slice from the returned tool set so a
   * read-only deployment advertises only the read / list / stat tools.
   * Defaults to `false`.
   */
  readOnly?: boolean;
  /**
   * Maximum number of UTF-8 characters the read tool returns before
   * truncation, forwarded to `makeMountReadTool`. Defaults to 50,000; `0`
   * disables the limit.
   */
  maxChars?: number;
}

export declare function makeMountReadTool(
  fs: ERef<Filesystem>,
  opts?: MountReadToolOptions,
): ToolRecord;

export declare function makeMountListTool(fs: ERef<Filesystem>): ToolRecord;

export declare function makeMountStatTool(fs: ERef<Filesystem>): ToolRecord;

export declare function makeMountEditTool(fs: ERef<Filesystem>): ToolRecord;

export declare function makeMountFsTools(
  fs: ERef<Filesystem>,
  opts?: MountFsToolsOptions,
): ToolRecord[];

/**
 * The slice of `HttpClient` exposed to an LLM: `fetch` (a single confined
 * outbound request) and `allowedOrigins` (report the reachable origins). The
 * origin allowlist, rate limit, response-byte cap, timeout, redirect
 * containment, and revocation are all enforced inside the `HttpClient` exo, so
 * this surface adds no authority beyond what the capability already carries.
 *
 * `help` is deliberately omitted — it is capability introspection, not an agent
 * action.
 */
export type HttpToolCapability = Pick<HttpClient, 'fetch' | 'allowedOrigins'>;

/**
 * The live `HttpResponse` remotable `HttpClient.fetch` returns. The `fetch`
 * tool never hands this across the wire; its `execute` projects it to a
 * JSON-safe `{ status, statusText, ok, url, headers, truncated, body }` record.
 */
export type HttpResponseView = HttpResponse;

export declare function makeHttpTool(
  httpCap: ERef<HttpToolCapability>,
): ToolRecord[];

/**
 * The `Git` slice a workspace catalog composes: the JSON-safe tool methods
 * ({@link GitToolCapability}) plus the mount-bridged `status` / `add` / worktree
 * methods ({@link GitMountToolCapability}). One granted `Git` supplies both the
 * versioning tools and — through its `worktree` mount — the file tools.
 */
export type WorkspaceGitCapability = GitToolCapability & GitMountToolCapability;

/**
 * The capabilities a synchronous workspace catalog is composed from. Every
 * field is optional: a tool group is present in the catalog only when its
 * backing capability is granted (daemon-agent-tools § Granting and
 * Provisioning, conditional composition).
 */
export interface WorkspaceGrants {
  /** Content layer: the mount `Filesystem` the file tools operate on. */
  filesystem?: ERef<Filesystem>;
  /**
   * Versioning layer: the granted `Git`. Its formula-owned commit identity
   * (captured at `provideGit` construction) attributes every commit; the
   * catalog never re-states it.
   */
  git?: ERef<WorkspaceGitCapability>;
  /** Network + credential layer: the granted `GitRemote` push tier. */
  remote?: ERef<GitRemoteToolCapability>;
  /** Command layer: the granted `Shell`. */
  shell?: ERef<ShellToolCapability>;
  /** Drop the file-tool write slice; forwarded to `makeMountFsTools`. */
  readOnly?: boolean;
  /** Read-tool truncation limit; forwarded to `makeMountFsTools`. */
  maxChars?: number;
  /** Advisory shell-tool veto policy; forwarded to `makeShellTool`. */
  shellOptions?: ShellToolOptions;
}

export declare function makeWorkspaceTools(
  grants?: WorkspaceGrants,
): ToolRecord[];

/**
 * Like {@link WorkspaceGrants} but the `Filesystem` is optional even when a
 * `Git` is granted: when omitted it is derived from the granted `Git`'s
 * worktree mount, so a single `Git` grant yields both the file tools and the
 * versioning tools over the same worktree.
 */
export interface ProvisionWorkspaceGrants extends Omit<WorkspaceGrants, 'git'> {
  git?: ERef<WorkspaceGitCapability & Pick<EndoGit, 'worktree'>>;
}

export declare function provisionWorkspaceTools(
  grants?: ProvisionWorkspaceGrants,
): Promise<ToolRecord[]>;

/**
 * Grant for {@link provisionHistoryTools}: a `Git` (used only for its
 * `filesystemAt` historical-read projection) and the ref to view.
 */
export interface HistoryToolsGrant {
  git: ERef<Pick<EndoGit, 'filesystemAt'>>;
  /** The ref to project as a read-only filesystem (`HEAD~1`, a branch, …). */
  ref: GitRef | string;
  /** Read-tool truncation limit; forwarded to `makeMountFsTools`. */
  maxChars?: number;
}

export declare function provisionHistoryTools(
  grant: HistoryToolsGrant,
): Promise<ToolRecord[]>;
