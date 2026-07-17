---
'@endo/sturdyref': minor
---

Add `@endo/sturdyref`, a first-wins shim and ponyfill that installs a
realm-shared `SturdyRef` namespace (`SturdyRef.fromLocation` /
`SturdyRef.toLocation`) at `globalThis.SturdyRef`, backed by a closely-held,
globally-retained `WeakMap` from an opaque passable sturdyref to its **locator
record** (an object, never a string). First-wins lets eval twins of ocapn or
captp that share a realm converge on one mapping and transport sturdyrefs. The
global carries no SES permit and is withheld from child compartments by
construction; the namespace and every sturdyref are hardened by `@endo/harden`,
installed lazily so hardening happens after `lockdown`. For distributed
confinement a sturdyref is `passStyleOf`-opaque (no location, no
identification): a guest holding one can neither read its locator nor correlate
two sturdyrefs of the same locator.
