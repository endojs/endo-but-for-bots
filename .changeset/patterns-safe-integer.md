---
'@endo/patterns': minor
---

Add `M.safeInteger()`, a matcher for a number that is a safe integer (as
`Number.isSafeInteger` decides), rejecting `NaN`, either signed Infinity, and
fractions. Compose it with `M.gte` and `M.lte` to bound the range, for example
`M.and(M.safeInteger(), M.gte(1), M.lte(256))`.
