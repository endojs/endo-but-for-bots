---
'@endo/daemon': minor
---

Add `readJson`, `maybeReadJson`, and `writeJson` to `EndoMount`.

`readJson(path) -> Promise<unknown>` performs a confined UTF-8 text read plus
`JSON.parse`, throwing when the file is missing or its content is not valid
JSON. `maybeReadJson(path) -> Promise<unknown | undefined>` returns `undefined`
when the read fails (a missing file, mirroring `maybeReadText`'s failure
envelope exactly), but a file that is present with invalid JSON still throws —
the parse sits outside the read's catch.

`writeJson(path, value) -> Promise<void>` is writable-gated and confined,
creates parent directories, and writes `JSON.stringify(value, null, 2)` plus a
trailing newline (POSIX-text friendly, a documented divergence from #127). It
throws when `JSON.stringify` returns `undefined` (non-serializable input) rather
than writing the literal string `"undefined"`, and the guard runs before any
directory is created so an invalid value leaves no filesystem trace.
