# @endo/mem-cas

## 0.1.0

### Initial scaffolding

- Factored out of `@endo/exo-npm` (previously
  `@endo/registry-capability`) so a common `CasStore` interface lives
  in one place and other backends (a future `@endo/git-cas`, the
  daemon's persistent `store-sha256` tree) can implement the same
  shape.
- `CasInterface` runtime guard and the `CasStore` TypeScript type. The
  naming drops the redundant trailing `Store` word: CAS already
  expands to Content-Address Store.
- `makeMemoryCasStore` Map-based reference implementation with
  caller-supplied `sha256` power.
- `sha256HexWebCrypto` Web Crypto power; callers in a Node-only host
  may supply a `node:crypto`-backed equivalent.
- `makeRetentionLinkSet` retention-link hook so the in-memory store
  honors pins from a caller (typically a formula graph).
