---
'ses': minor
---

SES now permits a `SturdyRef` global (as shimmed by `@endo/sturdyref`) when
one is present at `repairIntrinsics` time, and propagates that same
constructor to every child compartment, as it does for `HandledPromise`.
When no `SturdyRef` shim ran before `lockdown`, no `SturdyRef` global appears.
Lockdown also now leaves an existing non-configurable start-compartment
binding in place when it already holds the intrinsic SES would install, which
the first-wins shim relies on.
