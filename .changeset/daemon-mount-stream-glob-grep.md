---
'@endo/daemon': minor
'@endo/agent-tools': minor
'@endo/exo-stream': minor
'@endo/platform': minor
---

Add `streamGlob(pattern, options?)` and `streamGrep(pattern, files, options?)` to `EndoMount`, streaming counterparts of the eager `glob`/`grep` collectors.
Each returns a `PassableReader` synchronously (iterate with `iterateReader` from `@endo/exo-stream/iterate-reader.js`), yielding one element at a time — a mount-relative path for `streamGlob`, a `{ file, line, text }` record for `streamGrep`.
Unlike `glob`/`grep`, the streams have no result cap: the consumer's pull-based flow control is the bound.
`streamGrep` is decoupled from enumeration: `files` is a **mandatory** external stream of mount-relative paths to grep — a `PassableReader<string>` (the shape `streamGlob` returns), or a promise for one — not an options bag. Grep does not glob; it consumes the file stream a producer supplies, the streaming twin of the eager `grep(pattern, glob(g))` seam. "Search everything" and "search a glob subset" are expressed by composition: `streamGrep('TODO', streamGlob('**'))` and `streamGrep('TODO', streamGlob('*.js'))`. A supplied path that is denied, escapes confinement, is a directory, or is unreadable is skipped silently (the same uniform envelope eager `grep(pattern, paths)` guarantees), so a hand-supplied file stream cannot widen authority.
`streamGrep` reads the supplied files' contents lazily — one file per pull — so content reads never run ahead of demand and an early close leaves later supplied files unread. Whether the directory *walk* is incremental is the producer's concern: `streamGlob` keeps glob's global UTF-16 sort (its normative contract), so its walk stays eager (the whole tree is enumerated before the first path) and `streamGrep(p, streamGlob('**'))` is not walk-incremental. Fed `streamGlob(g)`, `streamGrep`'s record order is glob's sorted-path order — the same multiset of matches as eager `grep(pattern, glob(g))`.

Each accepts a `buffer` option (default `0`, clamped to `1024`) — a pre-acknowledge window for high-latency links.
A non-zero `buffer` widens the revocation-latency window: after `EndoMountControl.revoke()`, up to `buffer` already-acknowledged elements may still deliver before the next pull rejects; use `buffer: 0` for a hard revocation cutoff.
The search readers are minted once-only, so this window is bounded per reader — a grantee cannot open a second concurrent stream over the reader to multiply it.
A matched line of any length streams whole, matching eager `grep`: the element patterns opt out of the default `stringLengthLimit`, so no fixed ceiling can drop the matches after a long line.

`@endo/agent-tools`: the generated code-mode declarations are regenerated so the model-facing `fs`/`workspace` code-mode surface gains `streamGlob`/`streamGrep`.

`@endo/exo-stream`: `readerFromIterator` accepts a `once` option that latches the reader to a single `stream()` call (a second call rejects rather than starting a second walk over the shared iterator).

`@endo/platform`: `globPaths` gains a `sorted` option (default `true`, glob's UTF-16 sorted-path contract). With `sorted: false` the engine yields matched paths in walk order as it discovers them — no global-sort barrier before the first batch — over the same single walker, confinement, and denial filtering. This is the substrate for a future walk-order path producer; no shipped surface passes `sorted: false` yet (`streamGlob` keeps `sorted: true`), so the directory walk stays eager as described above.
