---
'@endo/cli': minor
---

Expose the mount `deniedSegments` option on the `endo mount` and `endo mktmp`
commands. A repeatable `--deny <segment>` flag names path segments (such as
`.ssh`) that **replace** the mount's default restricted set, and `--no-deny`
disables denial entirely with an empty set. When neither flag is given the
mount keeps its default `defaultDeniedSegments` set. The flags forward straight
to `provideMount` / `provideScratchMount`'s `deniedSegments` option, mirroring
the existing `--read-only` plumbing.
