---
'@endo/daemon': minor
'@endo/exo-git': minor
---

Model `EndoMountEntry` as a citable passable record.

`EndoMount.entry()` now returns a hardened passable record
`{ mountGrant, segments, displayPath }` instead of an
`EndoMountEntry` exo. Because the record's only capability slot is the
formula-backed `mountGrant`, it marshals through the daemon: an entry
can now be bound under a petname with `storeValue(entry, petname)` and
resolved back with `lookup(petname)`, which previously failed with
`No corresponding formula`.

- The entry's `segments` and `displayPath` are plain record fields, no
  longer `segments()` / `displayPath()` methods.
- The `child(name)` method is replaced by the free helper
  `childEntry(entry, name)` exported from `@endo/daemon`.
- `@endo/exo-git` git methods (`add` / `restore`) and the
  `GitStatusEntry.entry` field accept the entry-record shape rather
  than an `EndoMountEntry` remotable; mount-lineage provenance is still
  enforced through `mountGrant`.
