---
'@endo/compartment-mapper': patch
---

Fix a `bundle-source` nestedEvaluate / getExport-format bug where modules that
re-export one local binding under multiple names (for example
`export { details, details as X, details as redacted }`) left all-but-one alias
undefined at import time, surfacing as `TypeError: X is not a function` in
consumers.

The bundled `onceVar`/`liveVar` calling-convention object previously emitted
one property per export name keyed by the same local binding, and JavaScript
object-literal semantics silently retained only the last property.
The generator now collects all exported names per local binding and emits a
single fan-out setter that publishes to every corresponding cell.
