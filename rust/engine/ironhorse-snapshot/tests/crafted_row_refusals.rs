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

/// Finding 4: a persisted regexp whose source is structurally valid
/// (UTF-8, ascending owner) but does not RECOMPILE cannot come from an
/// honest writer. The adoption validator must refuse it before restore —
/// debug builds used to panic during restore while release builds
/// continued with the row silently dropped.
#[test]
fn a_regexp_row_that_cannot_recompile_is_refused_with_a_structured_error() {
    let m = quiescent_machine("var re = 0; var t = 0; re = /a(b+)c/g; t = 7; t");
    let bytes = m.write_snapshot(&sig()).expect("writes");
    let mut image = read_machine(&bytes, &sig()).expect("reads");
    assert!(!image.regexps.is_empty(), "the fixture persisted its regexp row");
    image.regexps[0].source = "(".to_string();
    let crafted = write_machine(&image);
    match from_snapshot_bytes(&crafted, &sig()) {
        Err(SnapshotError::Corrupt("regexp side table: persisted source does not compile")) => {}
        Err(other) => panic!("refused, but not by the adoption validator: {other:?}"),
        Ok(_) => panic!("a non-recompilable regexp row must not restore"),
    }
    let mut store = MemoryStore::new();
    store
        .commit(&image_to_batch(&image, 1, ""))
        .expect("the raw commit models a crafted writer");
    match validate_store(&store, &sig()) {
        Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "regexp side table: persisted source does not compile",
        ))) => {}
        Err(other) => panic!("store refused, but not by the adoption validator: {other:?}"),
        Ok(_) => panic!("a non-recompilable store row must not validate"),
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

/// The store mirror of the generator resume-cursor gate: the shared
/// bounds gate runs for both resume paths, so a raw-committed store
/// carrying a cursor at the segment end must be refused by
/// `validate_store` exactly as the container read refuses it. The
/// container arms (segment end, body end, an operand byte, a sibling
/// body's instruction start, and the saved-handler equivalents) live in
/// `generator_carry.rs`.
#[test]
fn a_generator_resume_cursor_outside_its_body_is_refused_at_store_validation() {
    let m = quiescent_machine(
        "var it = 0; var t = 0; \
         function* g() { var a = 11; yield a; yield a + 1; } \
         it = g(); t = it.next().value; t",
    );
    let bytes = m.write_snapshot(&sig()).expect("writes");
    let mut image = read_machine(&bytes, &sig()).expect("reads");
    assert_eq!(image.generators.len(), 1, "the fixture persisted its generator");

    let owner = image.generators[0].frame.as_ref().unwrap().cur_func;
    let segment = image
        .function_state
        .functions
        .iter()
        .find(|f| f.owner == owner)
        .and_then(|f| f.segment)
        .expect("the frame's function owns a segment");
    let past_the_body = image.function_state.segments[segment as usize].len() as u64;
    image.generators[0].frame.as_mut().unwrap().resume_pc = past_the_body;

    let mut store = MemoryStore::new();
    store
        .commit(&image_to_batch(&image, 1, ""))
        .expect("the raw commit models a crafted writer");
    match validate_store(&store, &sig()) {
        Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "generator frame: invalid resume cursor or scope map",
        ))) => {}
        Err(other) => panic!("store refused, but not by the named gate: {other:?}"),
        Ok(_) => panic!("a crafted resume cursor must not validate"),
    }
}

/// The `SIGN` gate covers the boot-derived slot layout, not only the
/// host callback table (see `Signature`). Adoption boots a fresh
/// machine and then replaces its arenas with the image's, so the
/// boot-derived maps keyed by slot index survive from the CURRENT
/// boot — a container written under a different boot layout would
/// attach this build's boot metadata to the image's unrelated slots,
/// silently, and nothing else would catch it: `boot_slot_count` is not
/// serialized and `VERS` versions the wire schema rather than the heap.
///
/// So the refusal must happen BEFORE adoption, on every path. This
/// pins that, and pins it for a container that is otherwise entirely
/// well formed — same version, same atoms, same everything but the
/// signature the writer stamped.
#[test]
fn a_container_from_a_foreign_boot_layout_is_refused() {
    let m = quiescent_machine("var t = 0; t = 41 + 1; t");
    // A different engine build: same wire schema, different boot layout,
    // therefore a different signature.
    let other_build = Signature::new("ironhorse-worker-v1-boot2");
    let bytes = m.write_snapshot(&other_build).expect("the other build writes");

    // Sanity: the bytes are honest under their OWN signature, so the
    // refusal below is about the signature and nothing else.
    from_snapshot_bytes(&bytes, &other_build).expect("honest under its own signature");

    match from_snapshot_bytes(&bytes, &sig()) {
        Err(SnapshotError::SignatureMismatch { expected, found }) => {
            assert_eq!(expected, sig());
            assert_eq!(found, other_build);
        }
        Err(other) => panic!("refused, but not by the signature gate: {other:?}"),
        Ok(_) => panic!("a container from a foreign boot layout must not adopt"),
    }

    // And the store path refuses at open, likewise before adoption.
    let mut store = MemoryStore::new();
    let image = read_machine(&bytes, &other_build).expect("reads under its own signature");
    store
        .commit(&image_to_batch(&image, 1, ""))
        .expect("the raw commit models the other build's writer");
    match validate_store(&store, &sig()) {
        Err(StoreError::Snapshot(SnapshotError::SignatureMismatch { .. })) => {}
        Err(other) => panic!("store refused, but not by the signature gate: {other:?}"),
        Ok(_) => panic!("a store from a foreign boot layout must not validate"),
    }
}

/// Canonical interchange: one logical machine must have exactly ONE
/// container encoding, or its SHA-256 is not an identity and the CAS
/// key is not a key. Three shapes broke that, all accepted before:
/// bytes after the declared `XS_M` envelope, a duplicate atom (which
/// `find` silently resolved to the first), and an optional side-table
/// atom present but EMPTY where the writer omits it entirely.
///
/// None of them produced a wrong answer — which is exactly why they
/// needed a gate rather than a test of behavior. The `NFLR` floor
/// already enforced this rule for itself; these extend it to the
/// envelope and the twenty-one optional atoms.
#[test]
fn non_canonical_container_encodings_are_refused() {
    let m = quiescent_machine("var a = 0; a = [1, 2, 3]; a.length");
    let bytes = m.write_snapshot(&sig()).expect("writes");
    read_machine(&bytes, &sig()).expect("the honest container reads");

    // (1) A trailing tail after the envelope.
    let mut tail = bytes.clone();
    tail.extend_from_slice(b"\x00\x00\x00\x08JUNK");
    match read_machine(&tail, &sig()) {
        Err(SnapshotError::Atom(_)) => {}
        other => panic!("bytes after the envelope must be refused: {other:?}"),
    }

    // (2) A duplicate atom. Splice a second, well-formed but EMPTY
    // `ARRY` in after the envelope header; the honest one is already
    // present, so this is a duplicate whichever the reader prefers.
    let mut dup = bytes.clone();
    let mut atom = Vec::new();
    atom.extend_from_slice(&12u32.to_be_bytes());
    atom.extend_from_slice(b"ARRY");
    atom.extend_from_slice(&0u32.to_be_bytes());
    dup.splice(8..8, atom.iter().copied());
    let grown = (u32::from_be_bytes([dup[0], dup[1], dup[2], dup[3]]) + 12).to_be_bytes();
    dup[0..4].copy_from_slice(&grown);
    match read_machine(&dup, &sig()) {
        Err(SnapshotError::Atom(_)) => {}
        other => panic!("a duplicate atom must be refused: {other:?}"),
    }

    // (3) A present-but-empty optional atom. Use a machine with NO
    // arrays, so the writer omits `ARRY` and the spliced empty one is
    // the only occurrence — isolating emptiness from duplication.
    let plain = quiescent_machine("var t = 0; t = 41 + 1; t");
    let plain_bytes = plain.write_snapshot(&sig()).expect("writes");
    let mut empty = plain_bytes.clone();
    empty.splice(8..8, atom.iter().copied());
    let grown =
        (u32::from_be_bytes([empty[0], empty[1], empty[2], empty[3]]) + 12).to_be_bytes();
    empty[0..4].copy_from_slice(&grown);
    match read_machine(&empty, &sig()) {
        Err(SnapshotError::Corrupt(msg)) if msg.contains("present but empty") => {}
        other => panic!("a present-but-empty optional atom must be refused: {other:?}"),
    }
}

// ---------------------------------------------------------------
// The promise cluster (`PRMS`, schema 23): rows that pass structural
// decode but lie about their cross-references. Each arm crafts one lie
// into an honest image and expects the specific refusal, on the
// container path — and, for the representative first arm, on the store
// path too (the SmallState section shares the decoder, so one mirror
// proves the sharing).

/// A pending promise with a stored resolver and a user reaction — the
/// minimal cluster with promises, functions, guards, and a reaction
/// row to mutate.
fn promise_fixture() -> Interp {
    quiescent_machine(
        "var p = 0; var res = 0; var g = 0; var t = 0; \
         p = new Promise(function (rs, rj) { res = rs; }); \
         p.then(function (v) { g = v; }); t = 7; t",
    )
}

/// A mid-flight `Promise.all` over two pending elements — the minimal
/// cluster with a live combinator row and two `Combine` reactions.
fn combinator_fixture() -> Interp {
    quiescent_machine(
        "var p1 = 0; var p2 = 0; var r1 = 0; var r2 = 0; var g = 0; var t = 0; \
         p1 = new Promise(function (rs, rj) { r1 = rs; }); \
         p2 = new Promise(function (rs, rj) { r2 = rs; }); \
         Promise.all([p1, p2]).then(function (v) { g = v; }); t = 7; t",
    )
}

fn expect_container_refusal(image: &ironhorse_snapshot::image::MachineImage, msg: &str) {
    let crafted = write_machine(image);
    match from_snapshot_bytes(&crafted, &sig()) {
        Err(SnapshotError::Corrupt(m)) if m == msg => {}
        Err(other) => panic!("expected Corrupt({msg:?}), got {other:?}"),
        Ok(_) => panic!("expected Corrupt({msg:?}), got an adopted machine"),
    }
}

#[test]
fn an_async_flavored_reaction_kind_is_refused_and_the_store_path_shares_the_gate() {
    let m = promise_fixture();
    let bytes = m.write_snapshot(&sig()).expect("writes");
    let mut image = read_machine(&bytes, &sig()).expect("reads");
    let row = image
        .promise_cluster
        .promises
        .iter_mut()
        .find(|p| !p.reactions.is_empty())
        .expect("the fixture holds a pending reaction");
    row.reactions[0].kind = 3; // AsyncAwait — a still-Pending frame
    expect_container_refusal(&image, "promise cluster: reaction kind does not resume");
    let mut store = MemoryStore::new();
    store
        .commit(&image_to_batch(&image, 1, ""))
        .expect("the raw commit models a crafted writer");
    match validate_store(&store, &sig()) {
        Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "promise cluster: reaction kind does not resume",
        ))) => {}
        other => panic!("the store path must share the reaction-kind gate: {other:?}"),
    }
}

#[test]
fn a_settled_promise_retaining_reactions_is_refused() {
    let m = promise_fixture();
    let bytes = m.write_snapshot(&sig()).expect("writes");
    let mut image = read_machine(&bytes, &sig()).expect("reads");
    let row = image
        .promise_cluster
        .promises
        .iter_mut()
        .find(|p| !p.reactions.is_empty())
        .expect("a pending reaction");
    row.state = 1; // Fulfilled — but settlement drains reactions
    expect_container_refusal(&image, "promise cluster: settled promise retains reactions");
}

#[test]
fn a_resolving_function_with_a_crafted_guard_or_promise_is_refused() {
    let m = promise_fixture();
    let bytes = m.write_snapshot(&sig()).expect("writes");
    let image = read_machine(&bytes, &sig()).expect("reads");
    assert!(!image.promise_cluster.functions.is_empty(), "resolvers persisted");

    let mut oor = image.clone();
    oor.promise_cluster.functions[0].guard = oor.promise_cluster.guards.len() as u32;
    expect_container_refusal(&oor, "promise cluster: guard index out of range");

    let mut orphan = image.clone();
    let absent = orphan
        .promise_cluster
        .promises
        .iter()
        .map(|p| p.owner)
        .max()
        .unwrap()
        + 1;
    orphan.promise_cluster.functions[0].promise = absent;
    expect_container_refusal(&orphan, "promise cluster: resolving function names no promise row");

    // An unreferenced guard cannot come from the compacting writer.
    let mut sparse = image.clone();
    sparse.promise_cluster.guards.push(false);
    expect_container_refusal(&sparse, "promise cluster: guards not densely referenced");

    // A resolver's name chunk has NO null exemption: the mint always
    // interns a real empty chunk, and reading a NULL one faults.
    let mut null_chunk = image;
    null_chunk.promise_cluster.functions[0].name_chunk = u32::MAX;
    expect_container_refusal(&null_chunk, "chunk offset out of arena bounds");
}

#[test]
fn a_crafted_combinator_row_is_refused() {
    let m = combinator_fixture();
    let bytes = m.write_snapshot(&sig()).expect("writes");
    let image = read_machine(&bytes, &sig()).expect("reads");
    assert_eq!(image.promise_cluster.combinators.len(), 1, "one live combinator");

    let mut kind = image.clone();
    kind.promise_cluster.combinators[0].kind = 4;
    expect_container_refusal(&kind, "promise cluster: unknown combinator kind");

    // An unreferenced combinator cannot come from the compacting writer.
    let mut sparse = image.clone();
    let extra = sparse.promise_cluster.combinators[0];
    sparse.promise_cluster.combinators.push(extra);
    expect_container_refusal(&sparse, "promise cluster: combinators not densely referenced");

    // `remaining` below the pending element reactions would underflow
    // at the drain (each settling element decrements it once).
    let mut low = image.clone();
    low.promise_cluster.combinators[0].remaining = 0;
    expect_container_refusal(&low, "promise cluster: remaining below its pending reactions");

    // The results accumulator must name an `ARRY` row — the element
    // drain writes through the dense store (the view-names-a-buffer-row
    // discipline). The derived promise's slot is live and in bounds,
    // but it is a promise, not an Array.
    let mut results = image;
    results.promise_cluster.combinators[0].results = results.promise_cluster.combinators[0].derived;
    expect_container_refusal(&results, "promise cluster: combinator's results Array has no row");
}

/// The two-sided collision property: `PRMS` restores its resolving
/// functions BEFORE `FUNC` adjudicates retained state, so a cluster
/// row crafted onto a guest function's slot is refused by `FUNC`'s
/// collision check (and a `FUNC` row onto a boot slot by `PRMS`'s own
/// `contains_key` refusal).
#[test]
fn a_resolver_crafted_onto_a_guest_function_slot_is_refused() {
    let m = quiescent_machine(
        "var p = 0; var res = 0; var f = 0; var t = 0; \
         p = new Promise(function (rs, rj) { res = rs; }); \
         f = function (x) { return x + 1; }; t = 7; t",
    );
    let bytes = m.write_snapshot(&sig()).expect("writes");
    let mut image = read_machine(&bytes, &sig()).expect("reads");
    let guest = image.function_state.functions[0].owner;
    image.promise_cluster.functions[0].function = guest;
    // Keep the rows strictly ascending after the overwrite.
    image
        .promise_cluster
        .functions
        .sort_unstable_by_key(|row| row.function);
    image.promise_cluster.functions.dedup_by_key(|row| row.function);
    let crafted = write_machine(&image);
    match from_snapshot_bytes(&crafted, &sig()) {
        Err(SnapshotError::Corrupt("side-table restore: malformed retained function state")) => {}
        Err(other) => panic!("the FUNC collision check must refuse the crafted slot: {other:?}"),
        Ok(_) => panic!("the FUNC collision check must refuse the crafted slot"),
    }
}
