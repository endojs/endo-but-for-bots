---
'@endo/daemon': minor
---

New: `makeUnconfined`, `makeArchive`, and `makeFromTree` accept caplet powers by
capability reference via `MakeCapletOptions.powers` (mutually exclusive with
`powersName`). A per-session powers cap can now be composed directly, without
minting a host pet name and removing it again afterward.

New: `evaluate` accepts an optional trailing `retainUntil` promise. When the
result is un-named (no `resultName`), its transient root is held until
`retainUntil` settles instead of being dropped as soon as the value resolves —
the ephemeral-root sibling of `resultName`. This lets a caller keep an
un-named (e.g. inline-evaluated) result alive long enough to compose it by
reference, for example as the `powers` of a `makeUnconfined` call. Default
behaviour is unchanged: an un-named `evaluate` with no `retainUntil` is still
ephemeral.
