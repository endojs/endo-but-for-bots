---
'@endo/daemon': minor
---

Add `glorp(globPattern, grepPattern, options?)` to `EndoMount` — the
grep-over-glob convenience combinator.

`glorp(globPattern, grepPattern, options?) -> Promise<Array<{ file, line, text }>>`
greps a pattern across exactly the files a glob matches. It is equivalent to
`grep(grepPattern, await glob(globPattern), options)`: `glob` remains the
independent producer of the path array, `grep` consumes it, and `glorp` is the
thin wiring between the two — it composes the public `glob` and `grep` faces
rather than threading glob into the grep engine, so the two stay decoupled
underneath. Each leg gets the same revocation gate, deny filtering, and
confinement it would if the caller chained them by hand, so a `subView`'s
`glorp` is scoped to its sub-root exactly as its `glob` and `grep` are.
`options` forwards `maxResults` (default 1000) to the grep leg, and the result
records match `grep` (`{ file, line, text }`, 1-based lines, CRLF-normalized).

This is the Array case; a streaming counterpart belongs to the separate
`streamGlob`/`streamGrep` design and is out of scope here.
