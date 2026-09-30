---
'@endo/sturdyref': minor
---

Add `@endo/sturdyref`, a first-wins shim and ponyfill that installs a
realm-shared `SturdyRef` constructor at `globalThis.SturdyRef`. A SturdyRef is
constructed like a `Proxy`, as `new SturdyRef(handler)`, where the handler's
`enliven` hook defines what the ref captures and how it is revived.
`SturdyRef.enliven(ref)` calls that hook in a later turn and returns a promise
for its result, and `SturdyRef.isSturdyRef(value)` is a brand check. Refs are
frozen, have no own properties, never expose their handler, and are distinct
even when made from the same handler. First-wins lets eval twins of ocapn or
captp that share a realm converge on one constructor. The constructor and every
ref are hardened by `@endo/harden`, installed lazily so hardening happens after
`lockdown`.
