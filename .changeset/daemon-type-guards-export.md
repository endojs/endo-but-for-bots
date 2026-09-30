---
'@endo/daemon': minor
'@endo/lal': patch
---

`@endo/daemon` now exports `NameShape`, `NamePathShape`, `NamePathArgumentShape`, and `NamePathsArgumentShape` from `@endo/daemon/type-guards.js` so consumers (notably `@endo/lal`) can validate pet-name and pet-name-path arguments against the same `@endo/patterns` matchers the daemon's own interfaces use, without redefining them locally.
