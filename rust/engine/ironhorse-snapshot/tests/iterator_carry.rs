//! The built-in iterator cursors persist (store schema v13, the `ITER`
//! atom): the `iterators` side table — array values/keys/entries
//! cursors, string iterators (UTF-16 byte cursors, surrogate pairs
//! stepped whole), for-in enumerators (inert across cranks: the
//! covered grammar cannot hold one), and Map/Set cursors. All pure
//! data plus weak slot references; every `next()` is a native on
//! rooted boot structure, so a resumed iterator CONTINUES its walk —
//! the `lastIndex` discipline the segment-iterator carry set.
//!
//! The collection cursors are the subtle rows: the `COLL` snapshot
//! COMPACTS tombstones (deleted entries whose physical index a live
//! cursor still holds), so the emitted cursor is the LIVE-entry
//! ordinal — which IS the physical index in the restored dense table
//! — and a `clear()`-staled cursor folds its staleness into `done`
//! (the absolute generation counter is unobservable; only "retired"
//! is). Before the carry these rows were dropped by resume and every
//! `next()` failed its this-guard — the twins diverge, the red this
//! suite was born failing.

mod common;

use common::TempDir;

use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, from_snapshot_bytes, resume_from_store,
    MachineSnapshot,
};
use ironhorse_snapshot::store::{validate_store, HeapStore, MemoryStore};
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::{parse_symbols, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    (bytecode, parse_symbols(&symbols))
}

/// Relink and run one crank, returning `(completed, halt debug, result,
/// computrons)`. The COMPUTRON count is part of the observation: a
/// resumed machine that answers correctly while charging differently
/// has still diverged, and consensus is on the count as much as the
/// value. Every twin below therefore compares metering too.
fn crank(m: &mut Interp, src: &str) -> (bool, String, String, u64) {
    let (b, n) = compile(src);
    let b = m.relink_crank(&b, &n).expect("relink");
    let o = m.run(&b);
    (o.completed, format!("{:?}", o.halt), o.result, o.computrons)
}

/// Run crank 1 and the observation cranks uninterrupted, and the same
/// cranks across a checkpoint/resume split on `store`; assert the
/// observations agree pairwise and return the continuous ones.
fn twin(crank1: &str, observations: &[&str], store: &mut dyn HeapStore) -> Vec<(bool, String, String, u64)> {
    let (b1, n1) = compile(crank1);

    let mut cont = Interp::new();
    cont.link_intrinsics(&n1);
    assert!(cont.run(&b1).completed, "crank 1 (continuous)");
    let continuous: Vec<_> = observations.iter().map(|s| crank(&mut cont, s)).collect();

    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1 (store)");
    let session = begin_store_session(m, &sig(), store)
        .map_err(|(_, e)| e)
        .expect("begin");
    drop(session);
    let mut session = resume_from_store(store, &sig()).expect("resume");
    let resumed: Vec<_> = observations
        .iter()
        .map(|s| crank(session.machine_mut(), s))
        .collect();
    assert_eq!(continuous, resumed, "resumed observes exactly as uninterrupted");
    checkpoint_to_store(&mut session, &sig(), store).expect("checkpoint after resume");
    validate_store(store, &sig()).expect("post-crank store validates");
    continuous
}

fn assert_twin(name: &str, crank1: &str, observations: &[&str], expect: &[&str]) {
    let mut mem = MemoryStore::new();
    let seen = twin(crank1, observations, &mut mem);
    for got in &seen {
        assert!(got.0, "observation completes: {:?}", got.1);
    }
    let got: Vec<&str> = seen.iter().map(|(_, _, r, _)| r.as_str()).collect();
    assert_eq!(got, expect, "the continuous observations are the real answers");

    let dir = TempDir::new(name);
    let mut file = FileStore::open(dir.join("heap.ihstore")).unwrap();
    twin(crank1, observations, &mut file);
}

#[test]
fn resumed_array_iterators_continue_their_walk() {
    assert_twin(
        "ih-iter-twin-array",
        "var it = 0; var it2 = 0; var t = 0; \
         it = [10, 20, 30].values(); t = it.next().value; \
         it2 = [7, 8].entries(); it2.next(); t",
        &[
            "var it; var t; var r = 0; r = it.next(); t = r.value + ':' + r.done; t",
            "var it; var t; var r = 0; r = it.next(); t = r.value + ':' + r.done; t",
            "var it; var t; var r = 0; r = it.next(); t = r.value + ':' + r.done; t",
            "var it2; var t; var r = 0; r = it2.next(); \
             t = r.value[0] + ':' + r.value[1] + ':' + r.done; t",
        ],
        &["20:false", "30:false", "undefined:true", "1:8:false"],
    );
}

#[test]
fn resumed_string_iterator_steps_surrogate_pairs_whole() {
    // 'ab😀c': crank 1 consumes 'a'; the resumed cursor must yield 'b',
    // then the astral character as ONE two-unit string (the byte
    // cursor mid-string travels exactly), then 'c'.
    assert_twin(
        "ih-iter-twin-string",
        "var si = 0; var t = 0; \
         si = 'ab\u{1F600}c'[Symbol.iterator](); si.next(); t = 7; t",
        &[
            "var si; var t; var r = 0; r = si.next(); t = r.value + ':' + r.done; t",
            "var si; var t; var r = 0; r = si.next(); t = r.value.length + ':' + r.done; t",
            "var si; var t; var r = 0; r = si.next(); t = r.value + ':' + r.done; t",
        ],
        &["b:false", "2:false", "c:false"],
    );
}

#[test]
fn resumed_map_cursor_straddles_a_tombstone_compaction() {
    // Entries [a†, b, c] (a deleted): the live cursor sits at PHYSICAL
    // index 2 after yielding 'b', but the COLL snapshot compacts the
    // tombstone away — the carried cursor must be the live ORDINAL (1),
    // which addresses 'c' in the restored dense table. Carrying the raw
    // physical index would skip 'c' entirely: the divergence this
    // twin's bite-check reproduces.
    assert_twin(
        "ih-iter-twin-map-straddle",
        "var m = 0; var mi = 0; var t = 0; \
         m = new Map(); m.set('a', 1); m.set('b', 2); m.set('c', 3); m.delete('a'); \
         mi = m.keys(); t = mi.next().value; t",
        &[
            "var mi; var t; var r = 0; r = mi.next(); t = r.value + ':' + r.done; t",
            "var mi; var t; var r = 0; r = mi.next(); t = r.value + ':' + r.done; t",
        ],
        &["c:false", "undefined:true"],
    );
}

#[test]
fn resumed_cleared_cursor_stays_retired() {
    // `clear()` retires every live cursor for good — even for entries
    // added afterwards, and even when no `next()` ran before the
    // suspend (staleness folds into the carried `done`).
    assert_twin(
        "ih-iter-twin-clear",
        "var m2 = 0; var ci = 0; var t = 0; \
         m2 = new Map(); m2.set('x', 1); ci = m2.keys(); m2.clear(); m2.set('y', 9); t = 7; t",
        &["var ci; var t; var r = 0; r = ci.next(); t = '' + r.done; t"],
        &["true"],
    );
}

#[test]
fn resumed_set_entries_iterator_answers_like_uninterrupted() {
    assert_twin(
        "ih-iter-twin-set",
        "var s = 0; var si2 = 0; var t = 0; \
         s = new Set(); s.add(5); s.add(6); si2 = s.entries(); si2.next(); t = 7; t",
        &[
            "var si2; var t; var r = 0; r = si2.next(); \
             t = r.value[0] + ':' + r.value[1] + ':' + r.done; t",
        ],
        &["6:6:false"],
    );
}

#[test]
fn blob_snapshot_carries_the_iterator_rows_too() {
    let (b1, n1) = compile(
        "var it = 0; var t = 0; it = [4, 5, 6].values(); t = it.next().value; t",
    );
    let obs = "var it; var t; t = it.next().value; t";

    let mut cont = Interp::new();
    cont.link_intrinsics(&n1);
    assert!(cont.run(&b1).completed, "crank 1 (continuous)");
    let continuous = crank(&mut cont, obs);
    assert_eq!(continuous.2, "5");

    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1 (blob)");
    let bytes = m.write_snapshot(&sig()).expect("suspend");
    let mut r = from_snapshot_bytes(&bytes, &sig()).expect("rebuild");
    let resumed = crank(&mut r, obs);
    assert_eq!(resumed, continuous, "blob twin agrees");
}
