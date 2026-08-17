// Public types for the in-memory Content-Address Store reference
// implementation and the common CAS interface.
//
// Other backends (a future `@endo/git-cas`, the daemon's persistent
// `store-sha256` tree) implement the same `CasStore` shape so callers
// can pin the interface without pinning the backing implementation.

/**
 * The Content-Address Store interface a content-addressed registry
 * (or any other CAS consumer) sits in front of.
 *
 * The naming here drops the redundant trailing `Store` word per the
 * "ATM Machine" rule: CAS already expands to Content-Address Store, so
 * `CasStore` would have read "Content-Address-Store Store".
 *
 * Scope is read/write/has by content hash. The in-memory
 * `makeMemoryCasStore` is the reference implementation. A persistent
 * backend (the daemon's `store-sha256` tree) and a future
 * `@endo/git-cas` implement the same surface.
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
   * absent.
   */
  evict(hash: string): Promise<boolean>;
  /** Bounded list, for diagnostics. */
  list(): Promise<string[]>;
}

/**
 * Compute a SHA-256 hex digest of the bytes.
 *
 * The shape is decoupled from any particular platform's crypto
 * primitive so the in-memory CAS store stays portable; callers wire
 * in `sha256HexWebCrypto` from `./src/store-web-powers.js` (Web
 * Crypto) or a `node:crypto`-backed equivalent.
 */
export type Sha256Hex = (bytes: Uint8Array) => Promise<string>;

/**
 * Retention-link hook that callers (typically a formula graph or
 * other dependency tracker) hold to pin CAS entries against eviction.
 *
 * The in-memory store evicts only entries the retention hook reports
 * as un-pinned, mirroring the daemon-side invariant that anything
 * reachable from a captured formula holds a hard retention link.
 */
export interface RetentionLinks {
  /** Pin `hash` so future `evict(hash)` returns false. */
  pin(hash: string): void;
  /** Release a previously installed pin. */
  unpin(hash: string): void;
  /** Test whether `hash` is currently pinned. */
  isPinned(hash: string): boolean;
}
