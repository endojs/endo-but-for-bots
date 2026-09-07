/**
 * Authored TypeScript types for the platform glob/grep search engine
 * (`./search.js`).
 * See designs/platform-search-pushdown.md.
 */

/**
 * The narrow read contract the engine walks with. No ambient authority: a
 * platform (or the daemon) supplies these, narrowed to its filesystem.
 */
export type SearchPowers = {
  /** List one directory level, entry names only. */
  readDirectory: (path: string) => Promise<Array<string>>;
  isDirectory: (path: string) => Promise<boolean>;
  /** Read a file as text; may reject (binary, permission) — grep skips it. */
  readFileText: (path: string) => Promise<string>;
  joinPath: (...segments: Array<string>) => string;
  /**
   * Resolve a path to its symlink-free physical path, or `undefined` when it
   * cannot be resolved. Used for both confinement and symlink-cycle detection.
   */
  maybeRealPath: (path: string) => Promise<string | undefined>;
};

export type GlobOptions = {
  /**
   * Lowercased restricted segment names. A denied directory is never descended
   * into and a denied name never appears in a result, even when matched
   * literally. `undefined` means no denial.
   */
  deniedSegments?: Array<string>;
  /**
   * The confinement boundary a resolved path may not escape. Defaults to the
   * walk `root`; a looked-up subdirectory handle walks from its own directory
   * but confines to the original mount root, so the two can differ.
   */
  confinementRoot?: string;
  /** Results per batch, clamped to `[1, MAX_BATCH_SIZE]`. */
  batchSize?: number;
  /** Include directory entries in results (default `true`). */
  includeDirectories?: boolean;
  /**
   * Emit results in the normative UTF-16 code-unit sorted order (default
   * `true`, glob's contract). When `false`, matched paths are yielded in *walk
   * order* as they are discovered, with no global-sort barrier — so the first
   * batch can be emitted before the whole tree is walked. Confinement and
   * denial filtering are unchanged; only the terminal sort is dropped. The
   * substrate for a walk-order path *producer* (the daemon's `streamGlob` /
   * `streamGrep`); decoupled `streamGrep` greps whatever file stream it is
   * handed and needs no sort of its own (see the engine header).
   */
  sorted?: boolean;
  /**
   * Let `**` descend through symbolic links to directories (default `false`).
   * A link is reported as an entry either way; this governs only recursion
   * through it, which turns the walk from a tree into a link graph. Segments
   * that name a path follow links regardless, being bounded by pattern depth.
   * Corresponds to `rg -L`.
   */
  followSymlinks?: boolean;
};

export type GrepOptions = {
  deniedSegments?: Array<string>;
  confinementRoot?: string;
  batchSize?: number;
  /** Applies to the implicit `**` walk when `paths` is omitted. */
  followSymlinks?: boolean;
  /** Stop after this many matches; `undefined` means unbounded (streaming). */
  maxResults?: number;
};

export type GrepMatch = {
  /** Mount-relative `/`-joined path of the matched file. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The matched line, with a trailing `\r` stripped. */
  text: string;
};

export type Search = {
  globPaths: (
    root: string,
    pattern: string,
    options?: GlobOptions,
  ) => AsyncGenerator<Array<string>>;
  grepFiles: (
    root: string,
    regexSource: string,
    paths?:
      | Iterable<string>
      | Promise<Iterable<string>>
      | AsyncIterable<Array<string>>,
    options?: GrepOptions,
  ) => AsyncGenerator<Array<GrepMatch>>;
};

/**
 * The file powers `provideSearch` selects an engine from: a superset of
 * `SearchPowers`' needs (via `realPath`) that may carry an optional native
 * `search`. Structurally satisfied by the daemon's `FilePowers`.
 */
export type SearchFilePowers = {
  readDirectory: (path: string) => Promise<Array<string>>;
  isDirectory: (path: string) => Promise<boolean>;
  readFileText: (path: string) => Promise<string>;
  joinPath: (...segments: Array<string>) => string;
  realPath: (path: string) => Promise<string>;
  /** An optional platform-native engine; when present it is used verbatim. */
  search?: Search;
};
