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
//! copy, and requires the same answer — which is a claim about eight carried
//! slots, three scalars, four packed flags and a remapped reaction index, not
//! just about the gate letting the machine through.

#[path = "common/twin.rs"]
mod carry;
use carry::{compile, twin, Observation};
use ironhorse_snapshot::format::SnapshotError;
use ironhorse_snapshot::image::{read_machine, write_machine_unchecked, MachineImage};
use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, from_snapshot_bytes, resume_from_store,
    MachineSnapshot,
};
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
/// row read back at the wrong index settles the wrong one.
///
/// This does NOT exercise the compaction remap, and an earlier version of
/// this comment claimed it did. Both accumulations are live, so the live set
/// is already dense and `fa_map` is the identity — a writer that skipped the
/// remap entirely passes this test.
/// `a_checkpoint_after_one_accumulation_settles_remaps_the_survivor` is the
/// one that needs a dead entry below a live one, and is what actually pins it.
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

/// An accumulation that REJECTS across the boundary, which is what carries
/// the `settled` latch: a resumed machine that lost it would settle twice or
/// not at all.
///
/// It does NOT reach `close_error`, and this comment used to claim it did.
/// The input is an Array, whose sync iterator has no `return`, so the close
/// path falls straight through to the rejection and the slot stays undefined.
/// `a_close_await_carries_the_error_it_is_unwinding_with` below is the
/// fixture that actually parks on `FromAsyncClose` with an error in flight.
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

/// The `close_error` slot and the `FromAsyncClose` step (reaction kind 10),
/// which no other fixture reaches.
///
/// A throwing `mapfn` starts an `AsyncIteratorClose`, and an iterator whose
/// `return()` answers with a still-unsettled promise parks the accumulation
/// on that close — holding the error it is unwinding with in `close_error`
/// until the close completes. A resumed machine that lost the slot rejects
/// with `undefined` instead of the real error, which no round-trip assertion
/// on the other fixtures can see: blanking `close_error` in the encoder left
/// the whole suite green before this test existed.
#[test]
fn a_close_await_carries_the_error_it_is_unwinding_with() {
    let mut store = store();
    let results: Vec<Observation> = twin(
        "var release; \
         var seen = 'none'; \
         var iterable = { \
             [Symbol.asyncIterator]() { \
                 var sent = false; \
                 return { \
                     next() { \
                         if (sent) return Promise.resolve({ done: true }); \
                         sent = true; \
                         return Promise.resolve({ value: 1, done: false }); \
                     }, \
                     return() { return new Promise(function (r) { release = r; }); } \
                 }; \
             } \
         }; \
         Array.fromAsync(iterable, function () { throw 'mapboom'; }) \
           .then(function () { seen = 'resolved'; }, \
                 function (e) { seen = 'rej:' + e; }); \
         seen",
        &["release({ done: true }); 0", "seen"],
        &mut store,
    );
    assert_eq!(
        results[1].2, "rej:mapboom",
        "the resumed close must reject with the carried error, not {:?}",
        results[1].2
    );
}

/// A checkpoint taken while entry 0 is DEAD and entry 1 is still live, which
/// is the only shape that tells the compaction remap apart from the identity.
///
/// Every other fixture writes at boot (all entries live, in order) or at the
/// end (all settled, arena empty), so `fa_map[&fa]` and `fa` agree and a
/// regression that skipped the remap would pass the whole suite. Here the
/// first accumulation settles before the checkpoint, so the writer emits the
/// surviving one at index 0 while its reaction still names index 1.
///
/// A skipped remap is not a subtle wrong answer: the writer's own image fails
/// the anchoring gate — "fromAsync: accumulations not densely referenced" —
/// so the machine cannot checkpoint itself at all. This is also the only test
/// that drives an INCREMENTAL `ASYN` write with live rows in it.
#[test]
fn a_checkpoint_after_one_accumulation_settles_remaps_the_survivor() {
    let signature = Signature::new("from-async-remap");
    let source = "var releaseA, releaseB; \
         var a = new Promise(function (r) { releaseA = r; }); \
         var b = new Promise(function (r) { releaseB = r; }); \
         var seenA = 'none'; var seenB = 'none'; \
         Array.fromAsync([a, 'a2']).then(function (o) { seenA = o.join('|'); }); \
         Array.fromAsync([b, 'b2']).then(function (o) { seenB = o.join('|'); }); \
         0";
    let (bytecode, names) = compile(source);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let mut store = MemoryStore::default();
    let mut session = begin_store_session(machine, &signature, &mut store)
        .map_err(|(_, e)| e)
        .expect("the boot image holds both accumulations");
    // Settle the FIRST one only. Its arena entry dies; the second stays live
    // at index 1 and must be written at index 0.
    assert!(carry::crank(session.machine_mut(), "releaseA('a1'); 0").0);
    checkpoint_to_store(&mut session, &signature, &mut store)
        .expect("a mid-flight checkpoint with a dead entry below a live one");
    validate_store(&store, &signature).expect("the remapped image validates");
    drop(session);
    let mut session = resume_from_store(&store, &signature).expect("resumes");
    // The survivor must still be the one the guest is holding.
    let released = carry::crank(session.machine_mut(), "releaseB('b1'); 0");
    assert!(released.0, "{:?}", released.1);
    let seen = carry::crank(session.machine_mut(), "seenA + '/' + seenB");
    assert_eq!(seen.2, "a1|a2/b1|b2", "the remapped survivor settled wrong");
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

/// The blob path's verdict on a crafted image, which is what the callers
/// assert by name.
///
/// The store path is checked too, but only as a weaker property: that it
/// cannot PRODUCE the machine. Most of these mutations do not even reach a
/// store gate — `commit` refuses the batch outright — so for those the store
/// arm below does not run at all. Where it does, which gate speaks depends on
/// the claim: a row-shape rule is structural and `validate_store` sees it,
/// while a claim about another table needs every table in place, which is
/// adoption. `crafted_row_refusals.rs` is where the store path's own verdict
/// is asserted by name.
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
        // The store must not be able to PRODUCE this machine. Which of its
        // two gates says so depends on the claim: a row-shape rule is
        // structural and `validate_store` sees it, while a claim about
        // another table is only visible once every table is in place, which
        // is adoption. Requiring either keeps this helper usable for both
        // without pretending the cheap gate catches what it cannot.
        assert!(
            validate_store(&store, &sig()).is_err() || resume_from_store(&store, &sig()).is_err(),
            "the store yields the crafted machine"
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

/// The two flags that make a claim about ANOTHER table, and the one
/// row-internal rule the decoder used to enforce in only one direction.
///
/// These are separate from the arm above because they are not row-shape
/// rules: nothing in the row itself is wrong, and only a cross-table check
/// after restore can tell. Each was admitted by BOTH paths before this, and
/// each then broke the next crank rather than the checkpoint — which is the
/// worst place for a corrupt store to surface.
#[test]
fn a_from_async_flag_that_disagrees_with_another_table_is_refused() {
    // `Array.fromAsync.call(C, ...)` accumulates into a plain constructor's
    // instance, so the honest row has TARGET_IS_ARRAY CLEAR. Setting it sends
    // the resumed machine down the dense-array store, which unwraps
    // `self.arrays` on a target that is not there.
    let non_array = image_of(
        "var release; \
         var pending = new Promise(function (r) { release = r; }); \
         function C() { this.tag = 'C'; } \
         Array.fromAsync.call(C, [pending, 'q']); 0",
    );
    assert!(
        !non_array.promise_cluster.from_async[0].has(FromAsyncRow::TARGET_IS_ARRAY),
        "the fixture must accumulate into a non-Array target"
    );
    assert_eq!(
        refusal(&non_array, |image| {
            image.promise_cluster.from_async[0].flags |= FromAsyncRow::TARGET_IS_ARRAY
        }),
        Err(SnapshotError::Corrupt(
            "side-table restore: malformed promise capability"
        ))
    );
    // An ASYNC iterator, whose honest row has SYNC_WRAPPED clear. Setting it
    // makes the resumed machine read a step promise as a `{value, done}`
    // record and walk until the meter stops it.
    let async_iterated = image_of(
        "var release; \
         var iterable = { \
             [Symbol.asyncIterator]() { \
                 return { next() { return new Promise(function (r) { release = r; }); } }; \
             } \
         }; \
         Array.fromAsync(iterable); 0",
    );
    let row = &async_iterated.promise_cluster.from_async[0];
    assert!(
        row.iterator != Slot::undefined() && !row.has(FromAsyncRow::SYNC_WRAPPED),
        "the fixture must hold a genuinely async iterator"
    );
    assert_eq!(
        refusal(&async_iterated, |image| {
            let row = &mut image.promise_cluster.from_async[0];
            row.iterator = Slot::undefined();
            row.next_method = Slot::undefined();
            row.flags |= FromAsyncRow::SYNC_WRAPPED;
        }),
        Err(SnapshotError::Corrupt(
            "fromAsync: iterator state without an iterator"
        ))
    );
    // An iterator with no `next` method: admitted by every row clause, and
    // the resumed accumulation then has nothing to step, so its result
    // promise never settles. A silent permanent stall, refused now.
    assert_eq!(
        refusal(&async_iterated, |image| {
            image.promise_cluster.from_async[0].next_method = Slot::undefined()
        }),
        Err(SnapshotError::Corrupt(
            "fromAsync: an iterator without its next method"
        ))
    );
}
