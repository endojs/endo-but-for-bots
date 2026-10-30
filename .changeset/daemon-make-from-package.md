---
'@endo/daemon': minor
---

Add `EndoHost.makeFromPackage(workerName, sourceName, options?)`, which runs a
caplet from a readable tree or mount whose root holds a `package.json`, with no
`node_modules` directory. The daemon resolves the declared dependencies through
`@registry` (or `options.registryName`, and `options.offline` to use only
packages the registry already holds), and a Node worker imports the package's
entry, or `options.entry`, through compartment-mapper. Each package links the
resolved version that satisfies its own declared range, so several majors of
one dependency can coexist. The caplet persists as a new `make-from-package`
formula. XS workers refuse it until compartment-mapper is hosted in XS.
