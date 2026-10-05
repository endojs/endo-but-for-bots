---
'@endo/sturdyref': patch
---

The `SturdyRef` constructor now captures `Promise`, `TypeError`, and `WeakMap` when the shim module evaluates, so a constructor that SES shares with every compartment does not late-bind to the start compartment's globals, which stay writable after `lockdown`.
