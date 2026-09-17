//! An in-flight `Array.fromAsync` accumulation carries its state across a
//! checkpoint (architecture finding F127, the last clause).
//!
//! `Array.fromAsync` is a **native** async state machine: it runs no guest
//! bytecode, so instead of a suspended frame it keeps a record in the
//! `from_async` arena and steps through it at each promise-job drain. Nothing
//! carried that arena, so the persist gate refused any machine holding a live
//! entry — "a promise reaction that would resume a non-persisted async frame"
//! — which is the finding's remaining residue.
//!
//! The fixture suspends an accumulation at a quiescent boundary the only way
//! it can be suspended: an element the guest has not resolved yet. The twin
//! then resolves it on both the continuous machine and its store-resumed
//! copy, and requires the same answer — which is a claim about eleven carried
//! slots, four packed flags and a remapped reaction index, not just about the
//! gate letting the machine through.

#[path = "common/twin.rs"]
mod carry;
use carry::{compile, twin, Observation};
use ironhorse_snapshot::format::SnapshotError;
use ironhorse_snapshot::image::{read_machine, write_machine_unchecked, MachineImage};
use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_snapshot::store::{image_to_batch_unchecked, validate_store, MemoryStore};
use ironhorse_snapshot::Signature;
use ironhorse_vm::snapshot_api::FromAsyncRow;
use ironhorse_vm::{Interp, Slot};

/// A `fromAsync` over a list whose first element is an unsettled promise, so
/// the accumulation is parked on a `FromAsync*` reaction at the end of the
/// crank. `seen` is the witness that the whole array arrived, in order, and
/// `mapped` that the map function and its `thisArg` travelled too.
const SUSPENDED: &str = "var release; \
     var pending = new Promise(function (r) { release = r; }); \
     var seen = 'none'; var tag = { mark: 'T' }; \
     Array.fromAsync( \
         [pending, 2, 3], \
         function (v, i) { return this.mark + (v * 10 + i); }, \
         tag) \
       .then(function (out) { seen = out.join('|'); }); \
     seen";

fn store() -> MemoryStore {
    MemoryStore::default()
}

/// The accumulation survives, and finishes with the same values on both
/// machines. Without the carry the checkpoint is refused outright, so this
/// test's first job is simply to get past the gate — and its second is to
/// prove the resumed arena is the one the writer compacted, since a row read
/// back at the wrong index would settle with the wrong elements.
#[test]
fn a_suspended_from_async_resumes_with_its_accumulation() {
    let mut store = store();
    let results: Vec<Observation> = twin(
        SUSPENDED,
        &[
            // Still parked: nothing has resolved the first element.
            "seen",
            // Release it. The drain runs the three steps and settles.
            "release(1); 0",
            // The accumulation's answer, mapped and index-aware.
            "seen",
        ],
        &mut store,
    );
    assert_eq!(
        results[2].2, "T10|T21|T32",
        "the resumed accumulation settled with {:?}",
        results[2].2
    );
    assert_eq!(results[0].2, "none", "it must still be parked at the start");
}

/// Two accumulations in flight at once, released in the opposite order, so a
/// row read back at the wrong index settles the wrong one. A single-row
/// fixture cannot catch an off-by-one in the compaction remap; this can.
#[test]
fn two_suspended_accumulations_keep_their_own_elements() {
    let mut store = store();
    let results: Vec<Observation> = twin(
        "var releaseA, releaseB; \
         var a = new Promise(function (r) { releaseA = r; }); \
         var b = new Promise(function (r) { releaseB = r; }); \
         var seenA = 'none'; var seenB = 'none'; \
         Array.fromAsync([a, 'a2']).then(function (o) { seenA = o.join('|'); }); \
         Array.fromAsync([b, 'b2']).then(function (o) { seenB = o.join('|'); }); \
         seenA + '/' + seenB",
        &[
            "releaseB('b1'); 0",
            "seenA + '/' + seenB",
            "releaseA('a1'); 0",
            "seenA + '/' + seenB",
        ],
        &mut store,
    );
    assert_eq!(
        results[1].2, "none/b1|b2",
        "releasing the SECOND accumulation settled {:?}",
        results[1].2
    );
    assert_eq!(results[3].2, "a1|a2/b1|b2");
}

/// The array-like path, which carries a different half of the row: an
/// `array_like` reference and a `len`, with `iterator` and `next_method`
/// absent. The decoder refuses a row that mixes the two, so this is also the
/// arm that proves the writer does not produce one.
#[test]
fn an_array_like_accumulation_carries_its_length() {
    let mut store = store();
    let results: Vec<Observation> = twin(
        "var release; \
         var pending = new Promise(function (r) { release = r; }); \
         var seen = 'none'; \
         Array.fromAsync({ length: 3, 0: pending, 1: 'y', 2: 'z' }) \
           .then(function (o) { seen = o.join('|'); }); \
         seen",
        &["release('x'); 0", "seen"],
        &mut store,
    );
    assert_eq!(results[1].2, "x|y|z");
}

/// An accumulation that REJECTS across the boundary. The `close_error` slot
/// and the `settled` latch are carried for this path, and a resumed machine
/// that lost them would either settle twice or not at all.
#[test]
fn a_rejecting_accumulation_resumes_its_rejection() {
    let mut store = store();
    let results: Vec<Observation> = twin(
        "var release; \
         var pending = new Promise(function (r, j) { release = j; }); \
         var seen = 'none'; \
         Array.fromAsync([pending, 2]).then( \
             function () { seen = 'resolved'; }, \
             function (e) { seen = 'rejected:' + e; }); \
         seen",
        &["release('boom'); 0", "seen"],
        &mut store,
    );
    assert_eq!(results[1].2, "rejected:boom");
}

fn sig() -> Signature {
    Signature::new("from-async-carry")
}

/// A machine halted at a quiescent boundary with the named source, read back
/// as an image. The fixtures below craft on top of this, so each starts from
/// bytes an honest writer produced.
fn image_of(source: &str) -> MachineImage {
    let (bytecode, names) = compile(source);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    let outcome = machine.run(&bytecode);
    assert!(outcome.completed, "{:?}", outcome.halt);
    let bytes = machine.write_snapshot(&sig()).expect("writes");
    let image = read_machine(&bytes, &sig()).expect("reads");
    assert_eq!(
        image.promise_cluster.from_async.len(),
        1,
        "the fixture holds one accumulation"
    );
    // The honest image round-trips byte for byte, so every refusal below is
    // the mutation's and not the fixture's.
    assert_eq!(
        read_machine(&write_machine_unchecked(&image), &sig()).unwrap(),
        image
    );
    image
}

/// The blob path's verdict on a crafted image. The store path is held to the
/// same verdict: a row-shape refusal lands at commit, an anchor refusal at
/// adoption, so this only requires that one of the two rejects it.
fn refusal(
    original: &MachineImage,
    mutate: impl FnOnce(&mut MachineImage),
) -> Result<(), SnapshotError> {
    let mut image = original.clone();
    mutate(&mut image);
    let verdict = from_snapshot_bytes(&write_machine_unchecked(&image), &sig()).map(|_| ());
    let mut store = MemoryStore::new();
    if ironhorse_snapshot::store::HeapStoreCommit::commit(
        &mut store,
        &image_to_batch_unchecked(&image, 1, ""),
    )
    .is_ok()
    {
        assert!(
            validate_store(&store, &sig()).is_err(),
            "store admits the crafted image"
        );
    }
    verdict
}

/// Every shape the row decoder and the anchoring gate name is refused, by
/// name. These are crafted because the writer cannot emit them: the arena is
/// compacted before it is written and the row is built from live state, so
/// each of these says what a reader must not believe about bytes it did not
/// write itself.
#[test]
fn crafted_from_async_rows_are_refused() {
    let iterated = image_of(SUSPENDED);
    let refused = |mutate: &dyn Fn(&mut MachineImage)| refusal(&iterated, mutate);
    // The anchoring discipline: one pending `FromAsync*` reaction per row,
    // and no row without one.
    assert_eq!(
        refused(&|image| image.promise_cluster.from_async.clear()),
        Err(SnapshotError::Corrupt(
            "fromAsync reaction: missing or duplicate accumulation"
        ))
    );
    assert_eq!(
        refused(&|image| {
            let row = image.promise_cluster.from_async[0].clone();
            image.promise_cluster.from_async.push(row);
        }),
        Err(SnapshotError::Corrupt(
            "fromAsync: accumulations not densely referenced"
        ))
    );
    // The row's own shape. An undefined bit is a byte no writer produces.
    assert_eq!(
        refused(&|image| image.promise_cluster.from_async[0].flags |= 1 << 6),
        Err(SnapshotError::Corrupt("fromAsync: unknown flag bit"))
    );
    // `mapfn` is callable only because `MAPPING` says so; this fixture maps,
    // so clearing the flag leaves a callable the resumed machine would not
    // call — and a reader that accepted it would drop the mapping silently.
    assert_eq!(
        refused(&|image| image.promise_cluster.from_async[0].flags &= !FromAsyncRow::MAPPING),
        Err(SnapshotError::Corrupt(
            "fromAsync: mapfn present without the mapping flag"
        ))
    );
    // The two input paths are exclusive, in both directions.
    assert_eq!(
        refused(&|image| image.promise_cluster.from_async[0].iterator = Slot::undefined()),
        Err(SnapshotError::Corrupt(
            "fromAsync: iterator state without an iterator"
        ))
    );
    assert_eq!(
        refused(&|image| image.promise_cluster.from_async[0].len = 1),
        Err(SnapshotError::Corrupt(
            "fromAsync: an iterated accumulation carries a length"
        ))
    );
    // `SYNC_WRAPPED` is a property of an iterator and means nothing without
    // one, so it is refused by the same clause even with `next_method` clear.
    assert_eq!(
        refused(&|image| {
            let row = &mut image.promise_cluster.from_async[0];
            row.iterator = Slot::undefined();
            row.next_method = Slot::undefined();
            row.flags |= FromAsyncRow::SYNC_WRAPPED;
        }),
        Err(SnapshotError::Corrupt(
            "fromAsync: iterator state without an iterator"
        ))
    );
    // The array-like path's own bound, which the iterator path cannot reach:
    // `k` walks up to `len` and a row past it would read off the end.
    let array_like = image_of(
        "var release; \
         var pending = new Promise(function (r) { release = r; }); \
         Array.fromAsync({ length: 2, 0: pending, 1: 'y' }); 0",
    );
    assert!(
        array_like.promise_cluster.from_async[0].iterator == Slot::undefined(),
        "the array-like fixture carries no iterator"
    );
    assert_eq!(
        refusal(&array_like, |image| {
            image.promise_cluster.from_async[0].k = image.promise_cluster.from_async[0].len + 1
        }),
        Err(SnapshotError::Corrupt(
            "fromAsync: index past the array-like length"
        ))
    );
}
