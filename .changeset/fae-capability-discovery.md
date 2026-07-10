---
'@endo/fae': minor
---

Discover and register the coding tools a guest's granted capabilities afford at worker startup.
`spawnWorkerLoop` now runs `discoverCapabilityTools` after building its built-in tools and adds the resulting `fs`/`shell`/`git` tools to the local tool map, adapting each canonical `ToolRecord` into Fae's `{schema,execute,help}` shape.
A statically-registered built-in of the same name wins, so discovery only ever adds, and discovery failure is logged rather than fatal (daemon-agent-tools Phase 4).
