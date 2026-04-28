---
'@endo/daemon': minor
---

Adds the foundation for the cross-peer garbage collection design
(`designs/daemon-cross-peer-gc.md`): the `SyncedPetStoreFormula` type and
its `SyncedEntry` / `SyncedPetStoreState` / `SyncedPetStoreMetadata`
companions, the pure CRDT merge primitives in
`synced-pet-store-crdt.js` (LWW-Register with tombstone bias on tie),
and an atomic-write persistence skeleton in
`synced-pet-store-persistence.js`.  The new formula type is added to
the discriminated union with a stub formulator branch that throws; it is
not yet wired into the invitation/accept flow, the formulator, the GC
graph, or the sync protocol.  Those steps land in subsequent PRs.
