---
'@endo/daemon': minor
---

Add `EndoDirectory.readOnly()`, which mints a read-only `ReadableNameHub` view
of a directory. The view exposes only the readable surface (`has`, `list`,
`lookup`, `maybeLookup`) and withholds every mutator; a less-trusted holder's
malformed arguments are rejected at the attenuation boundary by the guarded
`ReadableNameHub` exo. Attenuation is shallow: a looked-up nested directory is
returned live and writable. The view is expressed as an evaluation formula so
its durable identity is stable across restart, and daemon-internal code can
recognize the recipe (`isReadOnlyDirectoryFormula`) to reach the backing
directory without broadening the guest-facing attenuation.
