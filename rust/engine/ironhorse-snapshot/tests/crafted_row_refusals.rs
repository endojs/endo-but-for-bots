//! Review findings 4, 5 and 9: rows that pass STRUCTURAL decode but
//! cannot faithfully restore must be refused with structured errors on
//! every build profile — not debug-only asserts (release would
//! continue with silently missing exotic state), and not accepted into
//! a machine that cannot safely run or checkpoint.

use ironhorse_snapshot::format::SnapshotError;
use ironhorse_snapshot::image::{read_machine, write_machine};
use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_snapshot::store::{image_to_batch, validate_store, HeapStore, MemoryStore, StoreError};
use ironhorse_snapshot::Signature;
use ironhorse_vm::Interp;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

fn quiescent_machine(src: &str) -> Interp {
    let (b, n) = compile(src);
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let o = m.run(&b);
    assert!(o.completed, "fixture crank: {:?}", o.halt);
    m
}

/// Finding 4: a persisted regexp whose source passes decode (valid
/// UTF-8, ascending owner) but does not RECOMPILE cannot come from an
/// honest writer. The restore must refuse it by name — debug builds
/// used to panic on an assert while release builds continued with the
/// row silently dropped.
#[test]
fn a_regexp_row_that_cannot_recompile_is_refused_with_a_structured_error() {
    let m = quiescent_machine("var re = 0; var t = 0; re = /a(b+)c/g; t = 7; t");
    let bytes = m.write_snapshot(&sig()).expect("writes");
    let mut image = read_machine(&bytes, &sig()).expect("reads");
    assert!(!image.regexps.is_empty(), "the fixture persisted its regexp row");
    image.regexps[0].source = "(".to_string();
    let crafted = write_machine(&image);
    match from_snapshot_bytes(&crafted, &sig()) {
        Err(SnapshotError::Corrupt("side-table restore: persisted regexp does not recompile")) => {}
        Err(other) => panic!("refused, but not by the restore's named error: {other:?}"),
        Ok(_) => panic!("a non-recompilable regexp row must not restore"),
    }
}

/// Finding 5: the write verbs persist only QUIESCENT machines, whose
/// value stack is empty — so a populated `STAC` can only be crafted,
/// and used to be ACCEPTED, seeding a machine that can neither run a
/// crank nor checkpoint (every persist verb refuses it as
/// non-quiescent). The reader must enforce what the writer enforces.
#[test]
fn a_populated_stack_atom_is_refused_at_container_read() {
    let m = quiescent_machine("var t = 0; t = 1; t");
    let bytes = m.write_snapshot(&sig()).expect("writes");
    let mut image = read_machine(&bytes, &sig()).expect("reads");
    assert!(image.stack.is_empty(), "an honest snapshot has an empty stack");
    image.stack = vec![ironhorse_vm::Slot::undefined()];
    let crafted = write_machine(&image);
    match from_snapshot_bytes(&crafted, &sig()) {
        Err(SnapshotError::Corrupt("STAC not empty at a quiescent boundary")) => {}
        Err(other) => panic!("refused, but not by the quiescence gate: {other:?}"),
        Ok(_) => panic!("a populated STAC must not restore"),
    }
}

/// The store mirror of the STAC gate: a raw commit carrying a
/// populated stack section (a crafted store, or a writer predating the
/// gate) is refused at `validate_store` — the one function both
/// resume paths run.
#[test]
fn a_populated_stack_section_is_refused_at_store_validation() {
    let m = quiescent_machine("var t = 0; t = 1; t");
    let bytes = m.write_snapshot(&sig()).expect("writes");
    let mut image = read_machine(&bytes, &sig()).expect("reads");
    image.stack = vec![ironhorse_vm::Slot::undefined()];
    let mut store = MemoryStore::new();
    store
        .commit(&image_to_batch(&image, 1, ""))
        .expect("the raw commit models a crafted writer");
    match validate_store(&store, &sig()) {
        Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "STAC not empty at a quiescent boundary",
        ))) => {}
        Err(other) => panic!("refused, but not by the quiescence gate: {other:?}"),
        Ok(_) => panic!("a populated stack section must not validate"),
    }
}

/// Finding 9: `table_length` mirrors XS's power-of-two rehash
/// geometry, which the engine re-checks after every size change — so
/// zero (or any non-power-of-two, or a table whose grow threshold the
/// live size already crossed) cannot come from an honest writer, and
/// adopting it diverges the rehash boundaries (consensus-relevant
/// chunk metering) from an uninterrupted run. Decode used to accept
/// any value at all.
#[test]
fn a_crafted_collection_table_geometry_is_refused() {
    let m = quiescent_machine(
        "var m = 0; var t = 0; m = new Map(); m.set('a', 1); m.set('b', 2); t = 7; t",
    );
    let bytes = m.write_snapshot(&sig()).expect("writes");
    let image = read_machine(&bytes, &sig()).expect("reads");
    assert!(!image.collections.is_empty(), "the fixture persisted its Map row");
    let expect = |crafted: &[u8], want: &'static str| match from_snapshot_bytes(crafted, &sig()) {
        Err(SnapshotError::Corrupt(msg)) if msg == want => {}
        Err(other) => panic!("refused, but not by the geometry gate ({want}): {other:?}"),
        Ok(_) => panic!("crafted geometry must not restore ({want})"),
    };
    // Zero table for a populated Map — the review's example.
    let mut zeroed = image.clone();
    zeroed.collections[0].table_length = 0;
    expect(
        &write_machine(&zeroed),
        "collections side table: unreachable rehash geometry",
    );
    // Not a power of two.
    let mut lopsided = image.clone();
    lopsided.collections[0].table_length = 3;
    expect(
        &write_machine(&lopsided),
        "collections side table: unreachable rehash geometry",
    );
    // A power of two whose grow threshold the live size already
    // crossed (the add that crossed it would have doubled the table).
    let mut starved = image.clone();
    starved.collections[0].table_length = 1;
    expect(
        &write_machine(&starved),
        "collections side table: live size past the grow threshold",
    );
    // And the honest row still restores.
    assert!(from_snapshot_bytes(&write_machine(&image), &sig()).is_ok());
}

/// Additional review finding: an explicit `NFLR` equal to the
/// name-table length is the fully-installed state every writer
/// canonicalizes as an ABSENT atom, so an explicit one can only be
/// crafted — and accepting it re-canonicalizes on the next write,
/// breaking write(read(bytes)) == bytes.
#[test]
fn an_explicit_full_name_floor_is_refused_as_non_canonical() {
    let m = quiescent_machine("var t = 0; t = 1; t");
    let bytes = m.write_snapshot(&sig()).expect("writes");
    let mut image = read_machine(&bytes, &sig()).expect("reads");
    assert_ne!(
        image.name_floor,
        Some(image.names.len() as u32),
        "an honest writer canonicalizes the full floor as an absent atom"
    );
    image.name_floor = Some(image.names.len() as u32);
    match from_snapshot_bytes(&write_machine(&image), &sig()) {
        Err(SnapshotError::Corrupt(
            "installed-names floor: non-canonical explicit full floor",
        )) => {}
        Err(other) => panic!("refused, but not by the canonicality gate: {other:?}"),
        Ok(_) => panic!("a non-canonical explicit floor must not restore"),
    }
    // The store mirror: the same crafted floor in a raw-committed
    // small state is refused at validation.
    let mut store = MemoryStore::new();
    store
        .commit(&image_to_batch(&image, 1, ""))
        .expect("the raw commit models a crafted writer");
    match validate_store(&store, &sig()) {
        Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "installed-names floor: non-canonical explicit full floor",
        ))) => {}
        Err(other) => panic!("refused, but not by the canonicality gate: {other:?}"),
        Ok(_) => panic!("a non-canonical explicit floor must not validate"),
    }
}
