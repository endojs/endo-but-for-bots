---
'@endo/daemon': minor
'@endo/agent-tools': minor
---

Add `streamGlob(pattern, options?)` and `streamGrep(pattern, options?)` to `EndoMount`, streaming counterparts of the eager `glob`/`grep` collectors. Each returns a `PassableReader` synchronously (iterate with `iterateReader` from `@endo/exo-stream`), yielding one element at a time — a mount-relative path for `streamGlob`, a `{ file, line, text }` record for `streamGrep`.

Unlike `glob`/`grep`, the streams have no result cap: the consumer's pull-based flow control is the bound. Note the directory walk is still eager (the whole tree is enumerated before the first element), so early close bounds `streamGrep`'s remaining file reads but does not stop the walk.

Each accepts a `buffer` option (default `0`, clamped to `1024`) — a pre-acknowledge window for high-latency links. A non-zero `buffer` widens the revocation-latency window: after `MountControl.revoke()`, up to `buffer` already-acknowledged elements may still deliver before the next pull rejects; use `buffer: 0` for a hard revocation cutoff.
