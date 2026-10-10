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

#[path = "common/twin.rs"]
mod carry;
mod common;

use carry::{compile, crank, sig, twin};
use common::TempDir;

use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_vm::Interp;

/// Every path agrees with the uninterrupted machine, and the
/// uninterrupted machine gives the answers we actually expect.
fn assert_twin(name: &str, crank1: &str, observations: &[&str], expect: &[&str]) {
    let mut mem = MemoryStore::new();
    let cont = twin(crank1, observations, &mut mem);
    for got in &cont {
        assert!(got.0, "observation completes uninterrupted: {}", got.1);
    }
    let got: Vec<&str> = cont.iter().map(|(_, _, r, _)| r.as_str()).collect();
    assert_eq!(
        got, expect,
        "the continuous observations are the real answers"
    );

    let (b1, n1) = compile(crank1);
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1 (blob)");
    let bytes = m.write_snapshot(&sig()).expect("suspend");
    let mut r = from_snapshot_bytes(&bytes, &sig()).expect("rebuild");
    let blob: Vec<_> = observations.iter().map(|s| crank(&mut r, s)).collect();
    assert_eq!(blob, cont, "blob twin agrees");

    let dir = TempDir::new(name);
    let mut file = FileStore::open(dir.join("heap.ihstore")).unwrap();
    assert_eq!(
        twin(crank1, observations, &mut file),
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

#[test]
fn a_resumed_primitive_boolean_still_boxes_to_boolean_prototype() {
    // `boolean_proto` is the same class of handle as the three
    // `@@iterator` values above: a `SlotIndex` the interpreter holds
    // outside the heap, which resume re-derives only because
    // `create_intrinsics` records it BELOW `boot_slot_count`. Recorded
    // at link time instead, a resumed machine would carry
    // `SlotIndex::NULL`, the boxing arms' `is_null` guard would fall
    // through, and `true.toString()` would throw again on the resumed
    // side alone — green uninterrupted, broken after a suspend, which is
    // the defect class this whole file exists for. Both spellings of the
    // access, so neither read path can regress silently.
    assert_twin(
        "ih-boot-native-boolproto",
        "var t = 0; t = 7; t",
        &[
            "var t; t = true.toString(); t",
            "var t; t = String(false.valueOf()); t",
            "var t; t = true['toString'](); t",
            "var t; var k = 'valueOf'; t = String(true[k]()); t",
            "var t; t = String(true.constructor === Boolean); t",
            // The siblings, so a resume that lost one wrapper-prototype
            // handle while keeping another is still caught here.
            "var t; t = (42).toString(2); t",
            "var t; t = (1n).toString(); t",
            "var t; t = Symbol('t').toString(); t",
            "var t; t = String('abc'.length); t",
        ],
        &[
            "true",
            "false",
            "true",
            "true",
            "true",
            "101010",
            "1",
            "Symbol(t)",
            "3",
        ],
    );
}
