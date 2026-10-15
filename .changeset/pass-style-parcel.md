---
'@endo/pass-style': major
'@endo/marshal': patch
'@endo/parcel': patch
'@endo/patterns': major
---

`passStyleOf` now recognizes a Parcel, as shimmed by `@endo/parcel`, and returns the new pass style `'parcel'`.
Parcel is a dormant capability with no exposed data.
A child compartment recognizes Parcels only when `@endo/parcel/shim.js` installed the global before `lockdown`.
At runtime, nothing changes when no `Parcel` shim has run.

A Parcel is neither a key nor a pattern.
The related predicates and assertions now reject it directly, and `getRankCover` reports that it cannot be rank-ordered.
Parcel recognition is local in this layer: generic marshal encoding still rejects a Parcel with a clear error in either body format, and a dot membrane consequently rejects one too.
Direct rank comparisons with a distinct Parcel, or of distinct containers holding the same Parcel, also throw; comparing a value with itself and checking a singleton do not need a rank and retain their existing behavior.

Alongside that runtime behavior, the exported types change: the `PassStyle` union gains `'parcel'`, and `Passable` admits the new `ParcelObject` type, alone or inside a container.
A consumer with an exhaustive `switch` over `PassStyle`, or a `Record<PassStyle, ...>` table, stops type-checking until it adds a `'parcel'` case or narrows with `Exclude<PassStyle, 'parcel'>`.

In `@endo/patterns`, `M.kind('parcel')` matches a Parcel and infers `ParcelObject`.
The `Pattern` and `Matcher` types no longer admit an `Error` or a Parcel at any depth, matching what `isPattern` accepts, so a pattern typed with a nested error stops type-checking.
