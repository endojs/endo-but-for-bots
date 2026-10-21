---
'ses': patch
---

`lockdown()` now succeeds on Bun. Bun adds a non-configurable
`URLSearchParams.prototype.length` accessor that lockdown could not delete, so
lockdown threw. SES now permits `length` and Bun's `toJSON` on
`URLSearchParams.prototype`. Both disclose only the receiver's own entries and
are frozen with the rest of the shared intrinsics.
