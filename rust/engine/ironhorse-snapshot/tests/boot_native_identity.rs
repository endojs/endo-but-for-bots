//! A native minted DURING `link_intrinsics` rather than during
//! `Interp::new` lands ABOVE `boot_slot_count`, and nothing on the
//! resume path re-derives it: `image_to_interp` boots a fresh machine
//! (which mints only the boot natives) and then replaces its arenas
//! wholesale, so restore reinstates the heap REFERENCE to such a slot
//! but not the slot's `FuncInfo`. The property reads back as a plain
//! object and every call through it dies.
//!
//! Three `@@iterator` values were in that class --
//! `%IteratorPrototype%`'s, `%Segments.prototype%`'s, and the
//! `%SegmentIterator%` self-identity -- while their `Map`/`Set`/`String`
//! siblings, minted at boot, resumed fine. No hostile input is
//! involved: an honest machine silently lost callability. The fix is
//! to mint all three at boot beside those siblings; these
//! uninterrupted-vs-resumed twins are the difference, and they run on
//! the container path and both store paths.

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

fn continuous(crank1: &str, observations: &[&str]) -> Vec<(bool, String, String, u64)> {
    let (b1, n1) = compile(crank1);
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1 (continuous)");
    observations.iter().map(|s| crank(&mut m, s)).collect()
}

fn store_twin(crank1: &str, observations: &[&str], store: &mut dyn HeapStore) -> Vec<(bool, String, String, u64)> {
    let (b1, n1) = compile(crank1);
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1 (store)");
    drop(
        begin_store_session(m, &sig(), store)
            .map_err(|(_, e)| e)
            .expect("begin"),
    );
    let mut session = resume_from_store(store, &sig()).expect("resume");
    let seen: Vec<_> = observations
        .iter()
        .map(|s| crank(session.machine_mut(), s))
        .collect();
    checkpoint_to_store(&mut session, &sig(), store).expect("checkpoint after resume");
    validate_store(store, &sig()).expect("post-crank store validates");
    seen
}

/// Every path agrees with the uninterrupted machine, and the
/// uninterrupted machine gives the answers we actually expect.
fn assert_twin(name: &str, crank1: &str, observations: &[&str], expect: &[&str]) {
    let cont = continuous(crank1, observations);
    for got in &cont {
        assert!(got.0, "observation completes uninterrupted: {}", got.1);
    }
    let got: Vec<&str> = cont.iter().map(|(_, _, r, _)| r.as_str()).collect();
    assert_eq!(got, expect, "the continuous observations are the real answers");

    let (b1, n1) = compile(crank1);
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1 (blob)");
    let bytes = m.write_snapshot(&sig()).expect("suspend");
    let mut r = from_snapshot_bytes(&bytes, &sig()).expect("rebuild");
    let blob: Vec<_> = observations.iter().map(|s| crank(&mut r, s)).collect();
    assert_eq!(blob, cont, "blob twin agrees");

    let mut mem = MemoryStore::new();
    assert_eq!(store_twin(crank1, observations, &mut mem), cont, "store twin agrees");

    let dir = TempDir::new(name);
    let mut file = FileStore::open(dir.join("heap.ihstore")).unwrap();
    assert_eq!(
        store_twin(crank1, observations, &mut file),
        cont,
        "file-store twin agrees"
    );
}

#[test]
fn resumed_segments_iterate_like_uninterrupted() {
    assert_twin(
        "ih-boot-native-segments",
        "var sg = 0; var seg = 0; var t = 0; \
         sg = new Intl.Segmenter('en'); seg = sg.segment('ab'); t = 7; t",
        &[
            "var seg; var t; t = typeof seg[Symbol.iterator]; t",
            "var seg; var t; var n = 0; for (var x of seg) { n = n + 1; } t = n; t",
        ],
        &["function", "2"],
    );
}

#[test]
fn a_resumed_segment_iterator_is_still_its_own_iterable() {
    assert_twin(
        "ih-boot-native-segment-iter",
        "var sg = 0; var it = 0; var t = 0; \
         sg = new Intl.Segmenter('en'); it = sg.segment('ab')[Symbol.iterator](); t = 7; t",
        &["var it; var t; t = it[Symbol.iterator]() === it; t"],
        &["true"],
    );
}

#[test]
fn a_resumed_builtin_iterator_is_still_its_own_iterable() {
    // `%IteratorPrototype%[@@iterator]`, reached by `for..of` over a
    // built-in ITERATOR object rather than over the collection itself
    // (the collection's own `@@iterator` is a boot slot, which is why
    // `for (x of map)` never showed the defect).
    assert_twin(
        "ih-boot-native-iterproto",
        "var m = 0; var it = 0; var t = 0; \
         m = new Map(); m.set(1, 2); it = m.entries(); t = 7; t",
        &[
            "var it; var t; t = typeof it[Symbol.iterator]; t",
            "var it; var t; var n = 0; for (var e of it) { n = n + 1; } t = n; t",
        ],
        &["function", "1"],
    );
}
