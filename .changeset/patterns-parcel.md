---
'@endo/patterns': patch
---

A Parcel, the new `'parcel'` pass style of `@endo/pass-style`, is neither a key nor a pattern, like a promise or an error.
`isKey`, `isPattern`, and `matches` now answer `false` for one, and `assertKey` and `mustMatch` report that it cannot be a key or a pattern, instead of throwing an internal "unexpected passStyle" error.
`getRankCover` reports that a Parcel cannot be rank-ordered instead of throwing a `TypeError`.
