---
'@endo/captp': patch
'@endo/marshal': minor
'@endo/pass-style': minor
'@endo/patterns': patch
'@endo/spaces-util': patch
---

`@endo/marshal` now represents a Parcel inline in each marshal encoding.
CapData uses `{"@qclass":"parcel","location":"..."}` and Smallcaps uses an apostrophe immediately followed by the location; neither form consumes a slot.
The marshal owner supplies explicit `encodeParcel` and `decodeParcel` callbacks, so generic marshal code receives neither ambient location authority nor an ambient open hook.
The ordered passable encoding retains the `t` category prefix through its renamed `encodeParcel` and `decodeParcel` callbacks.
Parcels sort as their own tied rank category after strings and before `null`.
`@endo/patterns` treats a Parcel as neither a key nor a pattern, and `decodeToJustin` renders the inline location as `parcel(location)`.
The `Passable` type and passable arbitraries include Parcels under the literal `parcel` style.
