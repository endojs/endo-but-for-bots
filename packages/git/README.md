# `@endo/git`

Node-side `NativeGitBackend` for the Endo `Git` capability.
A subprocess wrapper over the installed `git` binary.

- `makeNativeGitBackend({ repoRoot, identity })` — implements the `GitBackend` protocol declared by `@endo/exo-git`.  Uses `node:child_process`, `node:fs`, `node:path`, etc.; not portable to SES realms without these built-ins.  The optional `identity` (`{ authorName, authorEmail }`) is a formula-owned commit-identity policy captured at construction and threaded into the author/committer environment of every mutating invocation; omitted, commits default to `Endo <endo@invalid.local>`.
- `internalHelpers` — test-only constants and helpers exported for assertion against `@endo/exo-git/src/git.js`.

Pair with `@endo/exo-git` for the remotable exo glue (`makeGit`, `makeGitRemote`, the credential capabilities, the `FsBackend` adapter, and the interface guards).
