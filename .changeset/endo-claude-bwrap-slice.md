---
'@endo/claude': minor
---

`runConfinedTurn` accepts an opt-in `sandbox: { bwrapPath }` option, and
`endo-claude-turn` a matching `--bwrap <path>` flag, that run the confined
`claude` inside a `bwrap` slice. Inside the slice the daemon socket has no
path: `claude` sees only the system directories, its own installation, the
guest's broker socket, its spawn files, and a writable working directory, with
a scratch `HOME`. The network namespace is still shared with the host. The
slice's building blocks (`makeBwrapSpawn`, `assembleBwrapArgv`,
`resolveSystemMounts`) and the `SliceMount` type are exported for deployment
companions.
