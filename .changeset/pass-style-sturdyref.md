---
'@endo/pass-style': minor
---

`passStyleOf` now recognizes a SturdyRef, as shimmed by `@endo/sturdyref`, and returns the new pass style `'sturdyRef'`.
Like a remotable, a SturdyRef has object identity and no data.
Passing a SturdyRef hands the receiver the authority to enliven it with `SturdyRef.enliven`.
Recognition uses the `SturdyRef` global of the compartment that loaded `@endo/pass-style`, so a child compartment recognizes the same refs only when the shim was installed before `lockdown`.
When no `SturdyRef` shim has run, nothing changes.
The `Passable` type admits the new `SturdyRefObject` type, alone or inside a container.
