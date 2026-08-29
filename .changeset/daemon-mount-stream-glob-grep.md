---
'@endo/daemon': minor
'@endo/agent-tools': minor
---

Add `streamGlob(pattern, options?)` and `streamGrep(pattern, options?)` to `EndoMount`: streaming counterparts of the eager `glob`/`grep` collectors.

`streamGlob(pattern, { buffer })` and `streamGrep(pattern, { glob, buffer })` each return a `PassableReader` synchronously (iterate with `iterateReader` from `@endo/exo-stream`), yielding one element at a time instead of a single capped array — a mount-relative path for `streamGlob`, a `{ file, line, text }` record for `streamGrep`.
Unlike `glob`/`grep`, there is no result cap: the consumer's pull-based flow control is the bound, so a stream can enumerate past `GLOB_MAX_RESULTS`/`GREP_MAX_RESULTS`.
`streamGrep`'s content reads are incremental — a consumer that stops early leaves the remaining files' contents unread, so early close bounds file reads.
For both methods, however, the directory walk itself is eager: the whole confined tree is enumerated before the first element (glob's global sort forces it), so closing a `streamGlob` early does not stop the walk.
Confinement, deny filtering, the glob dialect, symlink-cycle termination, CRLF normalization, and the revocation gate are identical to the eager methods by construction, since both ride the shared `@endo/platform/fs/search` engine.

The `buffer` option is the producer's pre-acknowledge window for high-latency links (default `0`, fully synchronized).
It is clamped to `STREAM_BUFFER_MAX = 1024` by `clampStreamBuffer`, both newly exported from `@endo/daemon`'s `mount.js`, so a remote caller cannot demand unbounded pre-materialization.
A non-zero `buffer` widens the revocation-latency window: up to the clamped buffer's worth of already-pre-acknowledged elements may still be delivered after a `MountControl.revoke()`; only the pull past the drained buffer rejects.
Because `buffer` is chosen by the party holding the `EndoMount` facet (the grantee), a grantor that mints a mount for an untrusted holder cannot force `buffer` to `0`; the clamp is what bounds the worst-case post-revocation delivery to at most `STREAM_BUFFER_MAX` elements.
A grantee that itself wants revocation to be a hard content cutoff keeps `buffer` at the default `0`, where the next pull after `revoke()` rejects with no further delivery.

`@endo/agent-tools`: the generated code-mode declarations (`generated/code-mode-globals/fs-declarations.js`) are regenerated so the model-facing tool surface includes `streamGlob`/`streamGrep`.
