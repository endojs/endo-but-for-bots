---
'@endo/cli': minor
---

`endo run` and `endo make` accept `-m,--mount <name>` to run a caplet from a
mount or readable tree through the daemon's `makeFromMount`, with an optional
`[file]` naming the entry module. `--registry <name>` picks the registry that
resolves a `package.json` mount (default `@registry`), and `--offline` resolves
only from packages that registry already holds.
