---
'@endo/exo-npm': major
---

The MVS resolve hook now selects the least published version that satisfies every range sharing a selection, instead of upgrading past what the graph requires.
Ranges that no single version can satisfy together, such as `~1.2.0` and `~1.3.0` or `^0.1.0` and `^0.2.0`, resolve to separate versions.
A union range such as `^1.0.0 || ^2.0.0` shares one version with a later narrower range when one exists.
Grouping depends only on the set of ranges requested, not on the order the walk meets them, so a resolution and its `resolutionHash` change for some inputs.
Tarballs are fetched, written to the CAS, and pinned only for the final closure, never for a superseded selection, and not at all when a peer check fails.
`satisfiesRange` admits a pre-release only through a comparator set that names a pre-release of the same `major.minor.patch`, compares numeric identifiers at full precision, rejects versions with trailing text, and bounds `^0.0.x-pre` ranges by their patch.
`parseRangeMajor` is removed from the package exports, which is the breaking change.
