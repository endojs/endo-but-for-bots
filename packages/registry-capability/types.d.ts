// Public types for the EndoRegistry capability.
//
// Reflects the capability shape defined in
// `designs/registry-capability.md` § Capability shape.
//
// This file is the source of truth for cross-package consumers; the
// runtime module guards (in `src/interfaces.js`) and the JS reference
// backend (in `src/reference-backend.js`) implement the same shape.

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
   * `keys` and their `integrity` strings.
   */
  resolutionHash: string;
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
  lookup(
    name: string,
    version: string,
  ): Promise<EndoReadableTree | undefined>;

  /** List installed packages (bounded). */
  list(
    prefix?: string,
  ): Promise<Array<{ name: string; version: string }>>;

  /** Documentation string. */
  help(): string;
}

/**
 * The CAS store interface the registry sits in front of.
 *
 * Scope is read/write/has by content hash. The daemon's persistent
 * CAS implements this surface; the in-memory `makeMemoryCasStore` is
 * a reference implementation for tests. See
 * `designs/registry-capability.md` § Caching and retention.
 */
export interface CasStore {
  /** Return true if the CAS holds bytes for `hash`. */
  has(hash: string): Promise<boolean>;
  /**
   * Read bytes for `hash`. Throws if the hash is unknown.
   */
  read(hash: string): Promise<Uint8Array>;
  /**
   * Write bytes; returns their content hash. Idempotent: writing
   * identical bytes twice returns the same hash.
   */
  write(bytes: Uint8Array): Promise<string>;
  /**
   * Drop `hash` from the store if no retention link pins it.
   * Returns true if the entry was evicted, false if it was pinned or
   * absent. This is the surface the daemon's eviction pass calls.
   */
  evict(hash: string): Promise<boolean>;
  /** Bounded list, for diagnostics. */
  list(): Promise<string[]>;
}

/**
 * Retention-link hook the formula graph holds to pin CAS entries.
 *
 * The snapshot mapper (`designs/snapshot-mapper.md`) adds a
 * `thisDiesIfThatDies` link from each `(compartmentMap,
 * resolutionHash, entrySnapshotHash)` formula into the CAS trees
 * resolution names. While any captured formula references a given
 * tree, that tree's CAS bytes are pinned and cannot be evicted.
 *
 * Layer 1 defines the typedef; layer 3 implements the wiring.
 */
export interface RetentionLinks {
  /** Pin `hash` so future `evict(hash)` returns false. */
  pin(hash: string): void;
  /** Release a previously installed pin. */
  unpin(hash: string): void;
  /** Test whether `hash` is currently pinned. */
  isPinned(hash: string): boolean;
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
 * Carries the CAS store, the retention-links hook, and a convenience
 * `makeTreeRef` factory so layer 2 does not have to re-derive the
 * connection to layer 1's CAS plumbing.
 */
export interface ResolveHookContext {
  cas: CasStore;
  retentionLinks: RetentionLinks;
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
