# `@endo/exo-git`

Remotable exo glue and interface guards for attenuated Git capabilities.
The package is intentionally Node-free and portable across SES realms — it knows nothing about subprocesses, the file system, or the host's `git` binary.

- `makeGitKit({ mount, backend, lineageOf })` — the Git exo class kit factory: one instance, three cumulative facets sharing a `filesystemAt` memo and mount lineage — `reader` (`ReadOnlyEndoGit`), `writer` (`ReadWriteEndoGit`, every reader method plus ordinary mutation), and `rewriter` (`HistoryRewriteEndoGit`, every writer method plus `reword` / `cherryPick` / `rebase` and an amend-capable `commit`). Posture is facet membership — a caller either holds a facet's methods or does not — not a runtime-checked flag. Every facet's `readOnly()` and `scope(name)` select a pre-existing sibling of the same instance (`scope` is strictly non-escalating: a facet may only select itself or a lower-authority sibling). `backend` is any object satisfying the `GitBackend` protocol (`@endo/git` provides the Node-side implementation).
- `makeGit({ mount, backend, lineageOf }, { readOnly, allowHistoryRewrite })` — a `makeGitKit` wrapper that returns exactly one selected facet, matching the call-site contract of the earlier single-class implementation: the default construction returns the `writer` facet (`ReadWriteEndoGit`), `{ allowHistoryRewrite: true }` returns `rewriter` (`HistoryRewriteEndoGit`), and `{ readOnly: true }` returns `reader` (`ReadOnlyEndoGit`).
- `makeGitOperations({ backend, git })` — mints the host-private `GitOperations` capability (the backend authority) alongside a Git kit, from the same `powers`. `git` should be the facet minted alongside `backend` by the same `makeGit` / `makeGitKit` call: it stamps the resulting `GitOperations` with that instance's ephemeral pairing token, without which `makeGitRemote` can never accept it. Never guest-visible and not derivable from `reader` / `writer` / `rewriter`; composing host code that built both passes `operations` explicitly to `makeGitRemote`.
- `makeGitRemote({ git, operations, credential, name, policy })` — remote-git companion (fetch / pull / push) bound to a credential cap; requires the writable `git` facet it composes with and the paired `operations` capability the same composing code minted.
- `normalizeGitRemotePolicy({ name, policy })` — the canonical parser, validator, and normalizer for the policy accepted by `makeGitRemote`.
- `makeBasicCredential`, `makeBearerCredential`, `makeUnavailableGitCredential` — credential capabilities.  Each carries a host-private `GitCredentialController` accessible via `getGitCredentialController(cred)`.
- `makeGitFsBackend({ backend, treeOid })` — `FsBackend` adapter for an immutable git tree.  Composes with `@endo/endo-fs` `wrapBackend(...)`.
- Interface guards: `GitReaderInterface`, `GitWriterInterface`, `GitRewriterInterface` (one per kit facet, generated from the shared `GIT_METHOD_GUARDS` table in `src/interfaces.js`), `GitInterface` (compatibility export equivalent to `GitRewriterInterface`, used by `@endo/agent-tools`'s JSON-tool and code-mode prompt generation), `GitTreeInterface`, `GitRemoteInterface`, `GitRemoteControllerInterface`, `GitCredentialControllerInterface`, `BasicCredentialInterface`, `BearerCredentialInterface`.

Sister packages:

- `@endo/git` — the Node-side `NativeGitBackend` (subprocess wrapper over the installed `git` binary).
- `@endo/endo-fs` — the `Filesystem` / `FsBackend` seam this package targets.

The split mirrors `@endo/exo-stream` / underlying stream sources: the exo layer is portable; the host-specific backing lives elsewhere.

## Remote policy normalization

`fetchRefspecs` and `pushRefspecs` retain their declared order through
normalization.
Consumers that serialize or hash a normalized policy must treat these arrays
as ordered and must not sort them.

An optional `defaultPullRef` names the fully qualified source side of exactly
one configured concrete fetch refspec, such as `refs/heads/main`.
An unqualified `GitRemote.pull()` integrates that mapping's destination.
For compatibility, when `defaultPullRef` is omitted, pull selects the first
declared concrete fetch refspec; empty and wildcard-only policies still require
an explicit pull branch.

Policy-consuming packages should import `normalizeGitRemotePolicy` from
`@endo/exo-git` instead of copying its normalization rules, and should preserve
the returned refspec order when forming canonical persistence or hash inputs.
