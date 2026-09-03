---
'@endo/daemon': minor
---

Add `glob`, `grep`, and `glorp` to `EndoMount`, delegating to the
`@endo/platform/fs/search` engine.

- `glob(pattern) -> Promise<string[]>` recursively enumerates paths matching a
  glob pattern, sorted by UTF-16 code unit and capped at `GLOB_MAX_RESULTS`
  (10000). The only metacharacters are `*` and `**`; every other character is a
  literal.
- `grep(pattern, paths?, options?) -> Promise<Array<{ file, line, text }>>`
  searches file contents for an ECMAScript RegExp source (no flags), returning
  `{ file, line, text }` records with 1-based line numbers and CRLF-normalized
  text. `paths` is a `string[]` (or a `Promise<string[]>` the exo awaits) so
  `glob` composes in: `grep(pattern, glob(g))`. Omitting `paths` searches every
  file under the mount face. `options.maxResults` (default 1000) caps match
  records; it must be a non-negative safe integer. A path that is denied,
  escapes confinement, resolves into a denied directory, is a directory, or
  cannot be read is skipped silently.
- `glorp(globPattern, grepPattern, options?)` is the fused glob+grep
  combinator: enumerate the files matching `globPattern` and search each for
  `grepPattern`. Both patterns are required positionals, so a native filesystem
  layer can fuse the enumerate-and-scan into one pass via `search.glorpFiles`.
  It honors the same confinement, deny filtering, and `maxResults` (default
  1000) as `grep`.

NOTE: `grep`/`glorp` compile a caller-supplied RegExp source on the daemon's
single event loop; a catastrophic-backtracking source can stall the daemon.
Supply trusted patterns.
