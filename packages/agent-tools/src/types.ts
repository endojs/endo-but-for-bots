import type { ERef } from '@endo/far';
import type { Filesystem } from '@endo/platform/fs/extended';
import type { EndoGit } from '@endo/exo-git';
import type { Pattern } from '@endo/patterns';

export type ArgKind = 'value' | 'capref' | 'capref[]';

/**
 * The guest authority a tool set closes over to resolve a capref-typed
 * argument. A capref arg crosses the wire as a **petname string** and is
 * resolved against the guest's own petstore via `E(powers).lookup(petname)` —
 * the same directory lookup every lal tool already uses. `lookup` fails closed:
 * the daemon directory throws on a petname it does not recognize, so a name the
 * host never bound can never dereference a cap.
 *
 * This is the `make(powers)` guest convention: the host passes `powers` once at
 * tool-set construction and every tool closes over it; `powers` is never an
 * argument the LLM supplies and is never ambient. Only the `lookup` capability
 * is exercised here, so this is the minimal structural type the tool layer
 * depends on (a full guest facet — an `EndoGuest` / directory — satisfies it).
 */
export interface ToolPowers {
  /** Petname → live cap. Throws on an unknown petname (fail closed). */
  lookup: (petNamePath: string | string[]) => Promise<unknown>;
}

/**
 * The read- and branch-navigation slice of `EndoGit` the git tool catalog
 * exposes to an LLM.
 *
 * Deliberately omits the destructive and history-rewriting methods of `EndoGit`
 * — `merge`, `rebase`, `restore`, `deleteBranch`, `renameBranch`, the `stash*`
 * family, and the working-tree/detach mutators (`add`, `switch`, `detach`,
 * `worktree`). Those carry authority a tool surface handed to a model should not
 * advertise: they can discard uncommitted work or rewrite shared history.
 * `commit`, `createBranch`, and `switchBranch` are included as the additive,
 * non-destructive write surface. Widening this `Pick` is a deliberate authority
 * decision, not a convenience — add a method only when the tool surface is meant
 * to grant it.
 */
export type GitToolCapability = Pick<
  EndoGit,
  | 'log'
  | 'diff'
  | 'show'
  | 'commit'
  | 'branches'
  | 'createBranch'
  | 'switchBranch'
  | 'currentBranch'
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
   * Optional per-positional marker, parallel to `argGuards`. `'value'` (the
   * default for an absent entry, and for the whole array when omitted) passes
   * the JSON value through unchanged; `'capref'` resolves a petname string to a
   * live cap via the guest petstore (`E(powers).lookup`) *before* the guard
   * runs; `'capref[]'` resolves an array of petname strings element-wise. This
   * is how an LLM names and passes a live capability as a tool argument — by
   * uttering the friendly petname the host bound it under. Plain
   * (non-capability) tools omit it, in which case `invoke` behaves exactly as it
   * did without any capref resolution.
   */
  argKinds?: ArgKind[];
  /**
   * The guest authority capref resolution sends `lookup` to. Threaded in at
   * tool-set construction (the `make(powers)` guest convention), never supplied
   * by the LLM. Required when `argKinds` marks any positional as a capref.
   */
  powers?: ERef<ToolPowers>;
  /**
   * Dispatch target. Receives the named-args record keyed by the schema's
   * declared `parameters.properties` names (e.g. `{ message }`, `{ name,
   * options }`) — with capref positionals already resolved to live caps (via
   * the petstore) when `argKinds` is set.
   */
  execute: (args: Record<string, unknown>) => Promise<unknown>;
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
  invoke: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: readonly string[];
      additionalProperties?: boolean;
    };
  };
}

export interface MountReadToolRecord {
  schema: () => ToolSchema;
  execute: (args: Record<string, unknown>) => Promise<string>;
  help: () => string;
}

export declare function makeTool(spec: ToolSpec): ToolRecord;

export declare function makeGitTool(
  gitCap: ERef<GitToolCapability>,
): ToolRecord[];

export interface MountReadToolOptions {
  /**
   * Maximum number of UTF-8 characters returned before truncation. Defaults to
   * 50,000. A value of `0` disables the limit and returns the full contents.
   */
  maxChars?: number;
}

export declare function makeMountReadTool(
  fs: ERef<Filesystem>,
  opts?: MountReadToolOptions,
): MountReadToolRecord;
