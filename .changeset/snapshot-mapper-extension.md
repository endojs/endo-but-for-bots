---
'@endo/compartment-mapper': minor
'@endo/daemon': minor
---

`@endo/compartment-mapper`: expose `mapPackageDescriptors` and a `dependencyLocationHook` option for callers that supply their own dependency-location resolver instead of walking a physical `node_modules` tree.

`@endo/daemon`: add `mapSnapshot` and `makeMountReadPowers`, which turn a `(EndoRegistry` resolution`, EndoMount)` pair into the `{ compartmentMap, resolution, readPowers }` trio in the compartment-mapper archive layout — registry-resolved packages land at `<name>@<version>/` peer directories (MVS major-coexistence), workspace members at versionless `<name>/` peers.
