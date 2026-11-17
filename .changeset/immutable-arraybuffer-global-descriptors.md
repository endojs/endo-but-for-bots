---
'@endo/immutable-arraybuffer': patch
---

Preserve the existing property attributes when the shim replaces global
TypedArray and DataView constructors. This lets SES `lockdown()` run after the
shim in a default Node VM context and preserves caller-defined attributes.
