---
'@endo/daemon': minor
---

Add `EndoHost.makeFromMount(workerName, sourceName, options?)`, which inspects
the root of a readable tree or mount once and runs it as a caplet: a root that
holds a `compartment-map.json` goes to `makeFromTree`, and a root that holds a
`package.json` goes to `makeFromPackage` with the same `entry`, `registryName`,
and `offline` options. A root with neither is refused, as are package-only
options on a compartment-map root.
