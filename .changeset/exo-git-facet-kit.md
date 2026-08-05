---
'@endo/exo-git': major
'@endo/daemon': patch
'@endo/agent-tools': patch
---

`@endo/exo-git`'s `makeGit` is now backed by a single `defineExoClassKit` instance with three cumulative facets (`reader`, `writer`, `rewriter`) instead of one exo class gated by runtime posture flags.
`makeGit(powers, opts)` keeps its existing call-site contract (selecting one facet by `readOnly` / `allowHistoryRewrite`), but a caller that already holds a facet can now downscope with `readOnly()` or `scope('reader' | 'writer' | 'rewriter')`, which always return the pre-existing sibling facet of the same instance.
`scope` is strictly non-escalating: a facet may only select itself or a lower-authority sibling.

Breaking changes:

- `getGitBackend` and the internal `gitBackends` side table are removed.
  `makeGitRemote` now requires an explicit `operations` argument: the host-private `GitOperations` capability minted by the new `makeGitOperations({ backend, git })`, alongside `git`, from the same composing code that built both.
  This capability is never guest-visible and cannot be derived from `reader`, `writer`, or `rewriter`.
  `makeGitRemote` verifies the pairing itself, against an ephemeral per-kit pairing token rather than `backend` object identity: `makeGitKit` mints a fresh, private, unforgeable token for each call (i.e. each Git formula evaluation, including reincarnation on upgrade), `makeGitOperations({ backend, git })` stamps that token onto the resulting `GitOperations`, and `makeGitRemote` rejects an `operations` value whose token does not match the specific `git` it claims to pair with.
  The token is never persisted; it does not need to survive an upgrade, only the durable `gitId` does.
- `isGitReadOnly` / `isGitHistoryRewrite` are reimplemented on top of the exo class kit's `receiveInstanceTester` (facet membership) rather than a `WeakMap` posture stamp.
  Their signatures and tri-state (`true` / `false` / `undefined` for non-daemon-minted caps) semantics are unchanged.
- A method absent from a facet's authority (e.g. `add` on the read-only facet, `reword` on the ordinary writer facet) is now simply absent from that facet.
  Calling it rejects with the exo dispatcher's "no such method" error instead of a runtime capability-check message.

`packages/daemon/src/manager.js` mints and holds the `GitOperations` capability for each `git` formula in a host-private `WeakMap` (mirroring `mount.js`'s own formula-backing pattern) and passes it explicitly when constructing a `git-remote` formula for the same `gitId`.

The generated `@endo/agent-tools` code-mode Git declarations gain the new `scope` method and the `WritableEndoGit` type.
