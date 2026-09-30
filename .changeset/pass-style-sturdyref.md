---
'@endo/pass-style': minor
---

`passStyleOf` now recognizes a SturdyRef, as shimmed by `@endo/sturdyref`, and returns the new pass style `'sturdyRef'`.
Like a remotable, a SturdyRef has object identity and no data.
Passing a SturdyRef hands the receiver the authority to enliven it with `SturdyRef.enliven`.
Recognition uses only the brand check of a frozen `globalThis.SturdyRef` constructor, and only for a frozen object with no own properties that inherits directly from `SturdyRef.prototype`.
An object that merely inherits from `SturdyRef.prototype`, a ref from a constructor that lost the first-wins race, and a ref made with a foreign `new.target` are all rejected.
The brand check is consulted only after every other pass style has declined a value, so it cannot reclassify a value that already has a pass style.
`globalThis` here is the global of the compartment that loaded `@endo/pass-style`, so a child compartment recognizes the same refs only when the shim was installed before `lockdown`.
When no `SturdyRef` shim has run, nothing changes.
