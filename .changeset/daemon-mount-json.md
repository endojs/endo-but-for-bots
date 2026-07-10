---
'@endo/daemon': minor
---

Add `readJson`, `maybeReadJson`, and `writeJson` to `EndoMount`.

`readJson(path) -> Promise<unknown>` performs a confined UTF-8 text read plus `JSON.parse`.
It throws when the file is missing or its content is not valid JSON.
`maybeReadJson(path) -> Promise<unknown | undefined>` returns `undefined` when the read fails (a missing file, or a path escaping confinement), mirroring `maybeReadText`'s failure envelope exactly.
A file that is present but holds invalid JSON still throws — the parse sits outside the read's catch.

`writeJson(path, value) -> Promise<void>` is writable-gated and confined, and creates parent directories as needed.
It writes `JSON.stringify(value, null, 2)` plus a trailing newline (a POSIX-text-friendly formatting choice: two-space indent and a final newline).
It throws when `JSON.stringify` returns `undefined` (non-serializable input) rather than writing the literal string `"undefined"`.
The guard runs before any directory is created, so an invalid value leaves no filesystem trace.
