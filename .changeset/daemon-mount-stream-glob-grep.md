---
'@endo/daemon': minor
'@endo/agent-tools': minor
'@endo/exo-stream': minor
'@endo/platform': minor
---

Add `streamGlob(pattern, options?)` and `streamGrep(pattern, { glob, buffer })` to `EndoMount`, streaming counterparts of the eager `glob`/`grep` collectors.
Each returns a `PassableReader` synchronously (iterate with `iterateReader` from `@endo/exo-stream/iterate-reader.js`), yielding one element at a time — a mount-relative path for `streamGlob`, a `{ file, line, text }` record for `streamGrep`.
Unlike `glob`/`grep`, the streams have no result cap: the consumer's pull-based flow control is the bound.
`streamGrep`'s `glob` option restricts the search to files matching a glob, piped into grep as path batches (so no full path array round-trips as grep's argument and the 10,000-path cap is dropped); omit it to search every file under the mount face.
`streamGrep` is fully incremental in the directory walk: it enumerates in walk order (grep needs no global sort), so a first match can arrive before the whole tree is walked and an early close bounds the directory walk itself, not only the remaining file reads. Its record order across files is therefore walk order rather than glob's UTF-16 sorted-path order — the same multiset of matches as eager `grep`, differing only in cross-file order. `streamGlob` keeps glob's global sort (its normative contract), so its walk stays eager: the whole tree is enumerated before the first path and early close bounds only marshalling.

Each accepts a `buffer` option (default `0`, clamped to `1024`) — a pre-acknowledge window for high-latency links.
A non-zero `buffer` widens the revocation-latency window: after `EndoMountControl.revoke()`, up to `buffer` already-acknowledged elements may still deliver before the next pull rejects; use `buffer: 0` for a hard revocation cutoff.
The search readers are minted once-only, so this window is bounded per reader — a grantee cannot open a second concurrent stream over the reader to multiply it.
An over-long line no longer aborts the stream: the element patterns opt out of the default `stringLengthLimit`, matching eager `grep`'s no-limit behavior (a single line past a fixed ceiling would otherwise drop every later match).
The clamp ceiling `STREAM_BUFFER_MAX` is newly exported from `@endo/daemon`'s `mount.js`.

`@endo/agent-tools`: the generated code-mode declarations are regenerated so the model-facing `fs`/`workspace` code-mode surface gains `streamGlob`/`streamGrep`.

`@endo/exo-stream`: `readerFromIterator` accepts a `once` option that latches the reader to a single active `stream()` (a second call rejects rather than starting a second walk over the shared iterator).

`@endo/platform`: `globPaths` gains a `sorted` option (default `true`, glob's UTF-16 sorted-path contract). With `sorted: false` the engine yields matched paths in walk order as it discovers them — no global-sort barrier before the first batch — over the same single walker, confinement, and denial filtering; this is what makes `streamGrep`'s directory walk incremental.
