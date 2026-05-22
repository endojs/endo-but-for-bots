---
'@endo/compartment-mapper': patch
---

Fix bundle generation for modules that export one local binding under multiple
names (for example `export { details, details as X, details as redacted }`).
The bundled `onceVar`/`liveVar` calling-convention object previously emitted
one property per export name keyed by the same local binding, and JavaScript
object-literal semantics silently retained only the last property: the
remaining cells (e.g. the `X` cell consumed by `import { X } from ...`)
were never populated and reads returned `undefined`. The generator now
collects all exported names per local binding and emits a single fan-out
setter that publishes to every corresponding cell.
