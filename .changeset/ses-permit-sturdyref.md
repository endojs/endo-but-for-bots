---
'ses': major
---

SES now permits a `SturdyRef` global (as shimmed by `@endo/sturdyref`) when one is present before `lockdown`, and propagates that same constructor to every child compartment, as it does for `HandledPromise`.
When no `SturdyRef` shim ran before `lockdown`, no `SturdyRef` global appears.
Lockdown also now leaves the shim's locked start-compartment `SturdyRef` binding in place when it is a non-writable, non-enumerable, non-configurable data property holding the intrinsic SES would install, which the first-wins shim relies on.
A non-configurable binding of any other universal global still makes `lockdown` throw, as does a non-configurable `SturdyRef` binding with any other attributes.
A configurable `SturdyRef` data property holding a value of the right shape does not throw: `lockdown` redefines it like any other universal global, writable and configurable, with the same value.
An application that already defines its own `SturdyRef` global before `lockdown` now makes `lockdown` throw, unless that value has the shape of the `@endo/sturdyref` constructor (a data property holding a function with an own non-writable, non-configurable object `prototype`, as every class has, and own `enliven` and `isSturdyRef` function statics); a plain `function` with a writable `prototype` throws; an accessor `SturdyRef` always throws, even when configurable.
Because a `lockdown` that previously succeeded can now throw, this is a breaking change.
This shape check guards against misconfiguration; it is not an authority check.
The shim freezes its constructor before `lockdown`, so its statics and prototype members must match the SES `SturdyRef` permit: a shim with an unpermitted member makes `lockdown` throw, and the two must change together.
