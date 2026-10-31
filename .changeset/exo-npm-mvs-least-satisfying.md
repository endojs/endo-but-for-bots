---
'@endo/exo-npm': minor
---

The MVS resolve hook now selects the least published version that satisfies every range sharing a selection, instead of upgrading past what the graph requires.
Ranges that no single version can satisfy together, such as `~1.2.0` and `~1.3.0` or `^0.1.0` and `^0.2.0`, resolve to separate versions.
A union range such as `^1.0.0 || ^2.0.0` shares one version with a later narrower range when one exists.
Pre-releases compare by full semver precedence and satisfy a range only when the range names a pre-release of the same version, in `satisfiesRange` as in resolution.
`parseRangeMajor` is removed from the package exports.
