# `@endo/git-object-store`

Portable hand-rolled Git loose-object codecs and a `GitObjectStore` backed by
an injected `ContentStore` plus an oid index.

See [`designs/cas-git-object-store.md`](../../designs/cas-git-object-store.md).

## What this package provides

- Codecs for blob, tree, commit, and tag loose objects
- Framing helpers that reconstruct `<type> <length>\0` canonical bytes
  for oid hashing without storing the header in the CAS
- An in-memory oid index and a SQLite-backed oid index
- `makeGitObjectStore` with `hasObject`, `readObject`, `readObjects`,
  and `writeObject`; reads are split into bounded batches
- Pure walk helpers for commit-graph log, tree walk, and
  commit-to-commit diff (proof surface for G1; not the exo-git
  backend partition)

## Relationship to native Git

This package owns the portable JavaScript object and CAS contract.
PR 987 ([the proposed native Git binding design](https://github.com/endojs/endo-but-for-bots/pull/987)) is expected to supersede the current PR 872 direction if it lands, with a full-power libgit2 adapter for packs, refs, transport, and other native repository behavior.
PR 987 remains open, so this package does not assume that proposal has landed.
The future portable `GitBackend` / `@endo/exo-git` immutable-tree seam is the intended consumer of this contract as portable coverage grows.
The portable layer and native backend direction are complementary, not competing semantic stores.
PR 872 ([the earlier gix-only Phase 1](https://github.com/endojs/endo-but-for-bots/pull/872)) remains the currently committed target-specific daemon-private implementation and is not duplicated here.

## Non-goals

Native packfiles, deltas, refs, wire protocol, transport, credentials,
worktrees, filesystem repositories, and the exo-git backend split are outside
this portable layer.
