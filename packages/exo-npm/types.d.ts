// Public types for the EndoRegistry capability.
//
// Reflects the capability shape defined in
// `designs/registry-capability.md` § Capability shape.
//
// This file is the source of truth for cross-package consumers; the
// runtime module guards (in `src/type-guards.js`) and the npm-scoped
// reference backend (in `src/reference-backend.js`) implement the
// same shape.
//
// The CAS-related types (`CasStore`, `RetentionLinks`, `Sha256Hex`)
// live in `@endo/mem-cas` and are imported across the package
// boundary.

/**
 * Opaque content-addressed handle to a directory tree in the CAS.
 *
 * In the integrated daemon this is the `EndoReadableTree` exo from
 * `@endo/daemon/src/interfaces.js`. The capability shape is defined
 * structurally so that layer 1 callers do not pin the daemon-side
 * type.
 */
export interface EndoReadableTree {
  /** Returns the content hash of the tree. */
  sha256(): string;
  /** Lists names at the given path. */
  list(...path: string[]): Promise<string[]>;
  /** Resolves a single entry. */
  lookup(path: string | string[]): Promise<unknown>;
  /** Tests for an entry. */
  has(...path: string[]): Promise<boolean>;
  /** Documentation string. */
  help(text?: string): string;
}

/**
 * The structure-preserving identifier for a host-scoped mount the
 * resolver may consult for workspace-rooted resolution.
 */
export type EndoMount = unknown;

/**
 * Options for `EndoRegistry.resolve`.
 */
export interface ResolveOptions {
  /** When true, fail rather than reach for the network. */
  offline?: boolean;
  /**
   * When the entry package is a workspace member, the enclosing
   * workspace root (a pet name or `EndoMount` handle). Enables
   * `workspace:` specifier resolution per `designs/mvs-resolver.md`.
   */
  workspaceRoot?: string | EndoMount;
}

/**
 * One entry per (package, version) in the transitive closure.
 *
 * Keyed by the canonical `<name>@<version>` string in
 * `RegistryResolution.packagesByKey`. The key shape matches npm's own
 * including the scoped-package leading `@`
 * (e.g. `'@endo/patterns@1.2.1'`, `'ses@1.0.0'`).
 */
export interface RegistryResolutionEntry {
  name: string;
  version: string;
  /** Readable-tree capability for the package contents. */
  treeRef: EndoReadableTree;
  /**
   * The upstream registry's published `dist.integrity`, retained for
   * cross-check against upstream attestations. Not used to verify
   * `treeRef`; the tree's content-address already proves the bytes.
   */
  integrity: string;
  /**
   * The `package.json` snapshot for this resolution entry, encoded as
   * a UTF-8 JSON string. Carries the declared `dependencies`,
   * `peerDependencies`, and `optionalDependencies` tables the resolver
   * needs to walk the transitive closure on a subsequent offline-mode
   * resolution against a cached entry. Optional so that a
   * caller-supplied row can omit it (the offline-mode walk reports an
   * `unmetOptional` for the missing snapshot rather than walking the
   * cached entry).
   */
  packageJson?: string;
}

/**
 * The result of `EndoRegistry.resolve`. Content-addressed for cache
 * reuse via `resolutionHash`.
 */
export interface RegistryResolution {
  /** `<name>@<version>` -> entry. */
  packagesByKey: Record<string, RegistryResolutionEntry>;
  /**
   * Canonical key list, ordered for stable hashing. Same set as
   * `Object.keys(packagesByKey)` in sorted order.
   */
  keys: string[];
  /**
   * Content-addressed hash of the resolution, computed by hashing
   * `keys` and their `integrity` strings. When the resolver was
   * constructed without a `sha256` power, this string is prefixed
   * with `nohash-` so consumers that care about cryptographic
   * collision-resistance can detect the non-cryptographic fallback.
   */
  resolutionHash: string;
  /**
   * Optional diagnostic channel for unmet optional dependencies the
   * resolver elided from the closure. Each entry names the importer,
   * the missing dependency, the range that did not resolve, and a
   * human-readable reason. Distinct from `workspaceMismatches` below:
   * an unmet optional is a missing package; a workspace mismatch is a
   * present package whose version disagrees with the importer's range.
   */
  unmetOptionals?: ReadonlyArray<{
    importer: string;
    name: string;
    range: string;
    reason: string;
  }>;
  /**
   * Optional diagnostic channel for workspace members whose version
   * does not satisfy an importer's declared range. The resolver still
   * resolves to the workspace member (workspace-wins semantics per
   * `designs/mvs-resolver.md` § Workspace resolution); the mismatch
   * is surfaced here so the caller can warn.
   */
  workspaceMismatches?: ReadonlyArray<{
    importer: string;
    name: string;
    range: string;
    version: string;
  }>;
}

/**
 * The daemon capability that brokers npm-style package resolution and
 * tarball fetch against a CAS.
 *
 * Mirrored on the worker side as the bus surface that crosses the
 * worker boundary. See `designs/registry-capability.md` § Capability
 * shape.
 */
export interface EndoRegistry {
  /**
   * Resolve a dependency graph rooted at a `package.json` and return
   * the selected versions with their CAS tree hashes. Uses MVS per
   * `designs/mvs-resolver.md`.
   *
   * The design's capability shape names a `Uint8Array` for the
   * package.json payload; the layer-1 implementation accepts a UTF-8
   * string because the exo boundary's pass-style check rejects
   * mutable typed arrays. The `Uint8Array` shape is preserved in the
   * design document; a follow-up may add a parallel
   * readable-blob-based entry for the binary path.
   */
  resolve(
    packageJson: string,
    options?: ResolveOptions,
  ): Promise<RegistryResolution>;

  /**
   * Fetch a single resolved package by (name, version) and return its
   * readable-tree capability. Idempotent: calling twice returns the
   * same content-addressed tree.
   */
  fetch(name: string, version: string): Promise<EndoReadableTree>;

  /**
   * Look up the cached resolution without fetching. Returns undefined
   * if the package is not yet in the table.
   */
  lookup(name: string, version: string): Promise<EndoReadableTree | undefined>;

  /** List installed packages (bounded). */
  list(prefix?: string): Promise<Array<{ name: string; version: string }>>;

  /** Documentation string. */
  help(): string;
}

/**
 * A single row in the npm-registry metadata cache.
 *
 * The reference backend's caller supplies a table-shaped object keyed
 * by package name; the row holds the cached resolution entry sorted by
 * version (dewey-decimal: major, minor, patch as separate columns
 * when the table is backed by SQLite). See
 * `designs/registry-capability.md` § Caching and retention.
 */
export interface PackageCacheRow {
  name: string;
  version: string;
  /** Parsed dewey-decimal version columns. */
  major: number;
  minor: number;
  patch: number;
  /** Readable-tree capability for the cached package contents. */
  treeRef: EndoReadableTree;
  /** Upstream registry's `dist.integrity`. */
  integrity: string;
  /**
   * The cached `package.json` snapshot for this row, encoded as a
   * UTF-8 JSON string. The MVS resolver reads this on an offline-mode
   * walk to enumerate the cached entry's transitive dependencies
   * without a packument fetch. Optional so that a SQLite-backed table
   * that does not yet carry the column degrades gracefully.
   */
  packageJson?: string;
}

/**
 * Caller-supplied table interface for the npm-registry metadata
 * cache the reference backend reads and writes.
 *
 * The interface is intentionally minimal: `get` / `put` / `list` over
 * a content-addressed-by-name key. A SQLite-backed implementation
 * projects the same shape over a `(name, major, minor, patch,
 * integrity, treeRef)` relational table; the in-memory analogue in
 * `./src/reference-backend.js` projects it over a `Map`.
 *
 * Sorting by version is the table's responsibility: `list(name)`
 * returns rows in dewey-decimal order (ascending by major, then
 * minor, then patch). A SQLite-backed implementation orders the
 * `SELECT` by the three integer columns; the in-memory implementation
 * sorts on each list call.
 */
export interface PackageCacheTable {
  /**
   * Return all cached rows for `name`, ordered ascending by
   * (major, minor, patch).
   */
  list(name: string): Promise<readonly PackageCacheRow[]>;
  /**
   * Return the cached row for the exact `(name, version)` pair, or
   * undefined if not cached.
   */
  get(name: string, version: string): Promise<PackageCacheRow | undefined>;
  /** Insert or replace a row. */
  put(row: PackageCacheRow): Promise<void>;
}

/**
 * Hook signature for layer 2's MVS resolution algorithm.
 *
 * Layer 1's reference backend invokes the hook with the entry
 * `package.json` bytes and the resolution options; layer 2's
 * `designs/mvs-resolver.md` implementation produces the resolution
 * by walking the dependency graph and writing tarball contents to
 * the CAS.
 *
 * The hook may return undefined to signal "not implemented", which
 * the reference backend surfaces as a structured error.
 */
export type ResolveHook = (
  packageJson: string,
  options: ResolveOptions,
  context: ResolveHookContext,
) => Promise<RegistryResolution>;

/**
 * Context the reference backend hands to a `ResolveHook`.
 *
 * Carries the CAS store, the retention-links hook, and the package
 * cache table so layer 2 does not have to re-derive the connection
 * to layer 1's plumbing.
 */
export interface ResolveHookContext {
  cas: import('@endo/mem-cas').CasStore;
  retentionLinks: import('@endo/mem-cas').RetentionLinks;
  /** Caller-supplied npm-registry metadata cache table. */
  packages: PackageCacheTable;
}

/**
 * Tags for the registry's failure surface.
 *
 * Used as `errorName` on the structured errors so callers branch on
 * the failure class without inspecting message text. See
 * `designs/registry-capability.md` § Failure surface.
 */
export type RegistryErrorName =
  | 'RegistryTamperedError'
  | 'RegistryMissingPackageError'
  | 'RegistryNetworkError'
  | 'RegistryOfflineError';
