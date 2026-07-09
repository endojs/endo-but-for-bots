---
'@endo/daemon': minor
---

Add `glob(pattern)` to `EndoMount`.

`glob(pattern) -> Promise<string[]>` recursively enumerates paths within the
mount face's confined root that match a glob pattern. The pattern language is
specified normatively so a Rust/XS implementation can match it exactly: the
pattern splits on `/` (empty segments are dropped, so `src//x` equals `src/x`
and a trailing slash is ignored; a pattern with no segments throws). The only
metacharacters are `*` and `**`. `*` matches zero or more characters within one
segment, never `/`, and does match leading-dot names (a documented divergence
from POSIX glob); `**` is special only as a whole segment and matches zero or
more directory levels (embedded, as in `a**b`, it degrades to `*`). Every other
character, including `?`, `[`, `]`, `{`, `}`, and `+`, is a literal.

Denied segments never appear in results, even when named literally (`.ssh/*`
returns `[]` rather than throwing); entries whose symlinks escape the mount root
are silently excluded. Results are mount-face-relative `/`-joined paths, include
directories as well as files, and are sorted lexicographically by UTF-16 code
unit as a final step, then capped at `GLOB_MAX_RESULTS` (10,000) with silent
truncation — the streaming search variants are the durable answer to unbounded
result sets.

This change also lands the shared, cross-language test fixture: a declarative
`test/mount-fixture-manifest.json`, a Node fixture builder
(`test/_mount-fixture.js`), and the glob variant case table
(`test/mount-glob-cases.json`) that a Rust/XS-side runner will consume to assert
Node/Rust parity.
