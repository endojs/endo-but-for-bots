## @endo/mem-cas

An in-memory Content-Address Store (CAS) reference implementation, and the
common `CasStore` interface other CAS backends implement.

The package is named `mem-cas` (Memory CAS) rather than `mem-store` so the
common shape can grow into a family: `@endo/git-cas` for git-backed
content addressing, and the daemon's persistent `store-sha256` tree
implements the same surface on disk.

## What this package provides

- The `CasStore` interface (TypeScript) and `CasInterface` runtime guard
  every backend shares. The naming intentionally drops the redundant
  trailing `Store` word: CAS already expands to Content-Address Store, so
  `CasStore` would have read "Content-Address-Store Store".
- A Map-based reference implementation (`makeMemoryCasStore`) suitable
  for tests and small in-process consumers. The store accepts a
  caller-supplied `sha256` power so the package does not bind to a
  particular platform's crypto primitive.
- A Web Crypto SHA-256 power (`sha256HexWebCrypto`) in
  `./store-web-powers.js` for browser, Node 19+, and SES-realm use,
  mirroring the daemon's `daemon-node-powers.js` vs `daemon-go-powers.js`
  split. Node-only callers may supply a `node:crypto`-backed power
  directly.
- A retention-link hook (`makeRetentionLinkSet`) for callers (typically
  a formula graph or other dependency tracker) to pin entries against
  eviction. The store evicts only entries the retention hook reports as
  un-pinned.

## What this package does not provide

- A persistent CAS backend. The daemon's `store-sha256` tree is a
  separate implementation of the same `CasStore` shape; unifying the two
  implementations behind one cross-package interface is tracked
  separately.
- A `git-cas` backend (placeholder for a future package).

## Status

Phase 1, reference implementation only. The interface and the in-memory
reference live here; the daemon's persistent CAS and a future
`@endo/git-cas` will adopt the same shape in follow-up work.
