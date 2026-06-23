---
'@endo/daemon': minor
---

New: `makeUnconfined`, `makeArchive`, and `makeFromTree` accept caplet powers by
capability reference via `MakeCapletOptions.powers` (mutually exclusive with
`powersName`). A per-session powers cap can now be composed directly, without
minting a host pet name and removing it again afterward.

New: `evaluate` accepts an optional trailing `retainUntil` promise. The result
is held as a transient root until `retainUntil` settles instead of being
dropped as soon as the value resolves — the ephemeral-root sibling of
`resultName`. This lets a caller keep a result (typically an un-named,
inline-evaluated one) alive long enough to compose it by reference, for example
as the `powers` of a `makeUnconfined` call. `retainUntil` is honored even when
`resultName` is also supplied. Default behaviour is unchanged: an un-named
`evaluate` with no `retainUntil` is still ephemeral.
