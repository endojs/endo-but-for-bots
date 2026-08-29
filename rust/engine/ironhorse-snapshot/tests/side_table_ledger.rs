//! Side-table ledger G1 locks: arrays, collections, and the
//! `Symbol.for` registry PERSIST across a store suspend/resume, so a
//! resumed machine answers cross-crank side-table reads exactly as an
//! uninterrupted one — lifting the wave-3 honesty finding (a resumed
//! `arr.length` used to answer `undefined` where the continuous
//! machine answered the real length). Every arm is an
//! uninterrupted-vs-resumed TWIN: the same two cranks run on one
//! continuous machine and on a checkpoint/resume split, and the crank-2
//! completion values must be equal AND the real answer (the bite
//! check: pre-ledger code answers `undefined` and fails loudly here).
//!
//! Crank discipline: crank 2 redeclares crank 1's names in order and
//! anchors every property/intrinsic name it shares, per the
//! bucket-ordered symbol-table contract the design records.

mod common;

use common::TempDir;

use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, from_snapshot_bytes, resume_from_store,
    MachineSnapshot,
};
use ironhorse_snapshot::store::{validate_store, HeapStore, MemoryStore, StoreError};
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::{read_machine, write_machine, Signature};
use ironhorse_vm::{parse_symbols, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    (bytecode, parse_symbols(&symbols))
}

/// Run both cranks uninterrupted, then run them across a
/// checkpoint/resume split on `store`, and return the two crank-2
/// completion values (uninterrupted, resumed).
fn twin(cranks: [&str; 2], store: &mut dyn HeapStore) -> (String, String) {
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks.iter().map(|s| compile(s)).collect();

    let mut cont = Interp::new();
    cont.link_intrinsics(&compiled[0].1);
    assert!(cont.run(&compiled[0].0).completed, "crank 1 (continuous)");
    let uninterrupted = cont.run(&compiled[1].0);
    assert!(uninterrupted.completed, "crank 2 (continuous)");

    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    assert!(m.run(&compiled[0].0).completed, "crank 1 (store)");
    let session = begin_store_session(m, &sig(), store)
        .map_err(|(_, e)| e)
        .expect("begin");
    drop(session);
    let mut session = resume_from_store(store, &sig()).expect("resume");
    let resumed = session.machine_mut().run(&compiled[1].0);
    assert!(resumed.completed, "crank 2 (resumed): {:?}", resumed.halt);
    // The resumed machine must also checkpoint cleanly — its restored
    // side tables re-serialize into the next commit.
    checkpoint_to_store(&mut session, &sig(), store).expect("checkpoint after resume");
    validate_store(store, &sig()).expect("post-crank store validates");

    (uninterrupted.result, resumed.result)
}

fn assert_twin(name: &str, cranks: [&str; 2], expect: &str) {
    let mut mem = MemoryStore::new();
    let (uninterrupted, resumed) = twin(cranks, &mut mem);
    assert_eq!(uninterrupted, expect, "uninterrupted answer is the real one");
    assert_eq!(resumed, expect, "resumed equals uninterrupted (memory)");

    let dir = TempDir::new(name);
    let mut file = FileStore::open(dir.join("heap.ihstore")).unwrap();
    let (_, resumed) = twin(cranks, &mut file);
    assert_eq!(resumed, expect, "resumed equals uninterrupted (file)");
}

#[test]
fn resumed_array_length_and_elements_read_like_uninterrupted() {
    // The headline honesty gap: `arr.length` and element reads after
    // a resume. 10 elements, read length + ends + a middle sum.
    assert_twin(
        "ih-ledger-twin-array",
        [
            "var arr = []; var i = 0; var t = 0; \
             for (i = 0; i < 10; i = i + 1) { arr[i] = i * 2; } \
             arr.length; t = 7; t",
            "var arr; var i; var t; \
             t = arr.length + arr[0] + arr[9] + arr[4]; t",
        ],
        // 10 + 0 + 18 + 8
        "36",
    );
}

#[test]
fn resumed_map_and_set_answer_like_uninterrupted() {
    // Crank 1's first-appearance name order is m, Map, s, Set, a, b,
    // t, v, set, add, get, has, size; crank 2 reproduces the exact
    // sequence (bare-identifier and property anchors), per the
    // bucket-ordered symbol-table contract.
    assert_twin(
        "ih-ledger-twin-coll",
        [
            "var m = new Map(); var s = new Set(); var a = 0; var b = 0; var t = 0; \
             a = { v: 1 }; b = { v: 2 }; \
             m.set(a, 10); m.set(b, 20); s.add(a); \
             m.get; m.has; m.size; t = 7; t",
            "var m; Map; var s; Set; var a; var b; var t; var v; \
             m.set; s.add; m.get; m.has; \
             t = m.size + s.size + m.get(a) + m.get(b) + (m.has(a) ? 100 : 0) + (s.has(b) ? 1000 : 0); t",
        ],
        // size 2 + size 1 + 10 + 20 + 100 + 0
        "133",
    );
}

#[test]
fn resumed_symbol_registry_keeps_symbol_for_identity() {
    // `Symbol.for('k')` minted before the suspend must be THE SAME
    // symbol after a resume — the registry row persists — and a
    // WeakMap entry written before the suspend must still answer.
    // Name order both cranks: sym, wm, WeakMap, o, t, Symbol, for,
    // v, set, get.
    assert_twin(
        "ih-ledger-twin-registry",
        [
            "var sym = 0; var wm = new WeakMap(); var o = 0; var t = 0; \
             sym = Symbol.for('k'); o = { v: 5 }; \
             wm.set(o, 42); wm.get; \
             t = 7; t",
            "var sym; var wm; WeakMap; var o; var t; \
             Symbol.for; var v; wm.set; \
             t = ((Symbol.for('k') === sym) ? 1 : 0) + wm.get(o); t",
        ],
        // identity 1 + 42
        "43",
    );
}

/// The array twin again, but resumed LAZILY and with a full
/// collection between resume and the read crank: the ledger rows
/// restore identically on the lazy path (they ride the small state,
/// never faulting), the rebuilt side-ref counts keep the collector's
/// projection sound (the debug parity net cross-checks every call),
/// and a full collect neither loses live rows nor trips the counted
/// sweep on restored entries.
#[test]
fn lazy_resumed_tables_survive_a_full_collect() {
    use std::cell::RefCell;
    use std::rc::Rc;

    let cranks = [
        "var arr = []; var m = new Map(); var a = 0; var i = 0; var t = 0; \
         a = { v: 1 }; \
         for (i = 0; i < 10; i = i + 1) { arr[i] = i * 2; } \
         m.set(a, 30); m.get; arr.length; t = 7; t",
        "var arr; var m; Map; var a; var i; var t; var v; \
         m.set; \
         t = arr.length + arr[9] + m.get(a); t",
    ];
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks.iter().map(|s| compile(s)).collect();

    let mut cont = Interp::new();
    cont.link_intrinsics(&compiled[0].1);
    assert!(cont.run(&compiled[0].0).completed);
    cont.collect_garbage();
    let uninterrupted = cont.run(&compiled[1].0);
    assert!(uninterrupted.completed);
    // 10 + 18 + 30
    assert_eq!(uninterrupted.result, "58");

    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    assert!(m.run(&compiled[0].0).completed);
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    drop(
        begin_store_session(m, &sig(), &mut *store.borrow_mut())
            .map_err(|(_, e)| e)
            .expect("begin"),
    );
    let mut session =
        ironhorse_snapshot::machine::resume_from_store_lazy(store.clone(), &sig()).expect("lazy");
    session.machine_mut().collect_garbage();
    let resumed = session.machine_mut().run(&compiled[1].0);
    assert!(resumed.completed, "resumed crank 2: {:?}", resumed.halt);
    assert_eq!(resumed.result, "58", "lazy resume + collect equals uninterrupted");
    checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut()).expect("checkpoint");
    validate_store(&*store.borrow(), &sig()).expect("validates");
}

#[test]
fn side_tables_round_trip_the_container_and_stay_canonical() {
    // The container path: a machine carrying all three tables writes
    // atoms that read back to the identical image, twice-encoded
    // byte-identically (canonical form). A side-table-FREE machine
    // must emit none of the ledger atoms — the container-stability
    // rule that kept every golden pin in place.
    let (bytecode, symbols) = compile(
        "var arr = []; var m = new Map(); var sym = 0; var i = 0; var t = 0; \
         for (i = 0; i < 5; i = i + 1) { arr[i] = i; } \
         m.set(arr, 9); sym = Symbol.for('q'); t = 7; t",
    );
    let mut m = Interp::new();
    m.link_intrinsics(&symbols);
    assert!(m.run(&bytecode).completed);
    let image = m.snapshot_image(&sig());
    assert!(!image.arrays.is_empty(), "fixture carries arrays");
    assert!(!image.collections.is_empty(), "fixture carries a Map");
    assert!(!image.registry.is_empty(), "fixture carries a registration");
    let bytes = write_machine(&image);
    let reread = read_machine(&bytes, &sig()).expect("read back");
    assert_eq!(reread, image, "side tables round-trip the container");
    assert_eq!(write_machine(&reread), bytes, "canonical bytes");

    let empty = Interp::new().snapshot_image(&sig());
    assert!(empty.arrays.is_empty() && empty.collections.is_empty() && empty.registry.is_empty());
    let empty_bytes = write_machine(&empty);
    for tag in [b"ARRY".as_slice(), b"COLL".as_slice(), b"REGY".as_slice()] {
        assert!(
            !empty_bytes.windows(4).any(|w| w == tag),
            "side-table-free container carries no ledger atoms",
        );
    }
}

/// G2 — per-crank relinking: a later crank compiled against a
/// DIFFERENT symbol table (reordered names, a subset, and genuinely
/// new names) runs correctly after `relink_crank` rewrites its ID
/// operands onto the machine's persisted table. The pre-G2 world
/// required textual alignment; this crank deliberately violates it
/// every way at once. The resumed machine and a continuous machine
/// relink identically (both carry the same persisted table), and the
/// answer is the true one.
#[test]
fn relinked_misaligned_crank_answers_like_an_aligned_one() {
    let crank1 = "var arr = []; var m = new Map(); var a = 0; var i = 0; var t = 0; \
                  a = { v: 1 }; \
                  for (i = 0; i < 10; i = i + 1) { arr[i] = i * 2; } \
                  m.set(a, 30); m.get; arr.length; t = 7; t";
    // Reordered (t first), a subset (no i), new names (q, w), fresh
    // property use (arr[3]).
    let crank2 = "var t; var q = 0; var arr; var m; var a; var w = 0; \
                  q = arr.length; w = m.get(a); \
                  t = q + w + arr[3]; t";
    let (b1, n1) = compile(crank1);
    let (b2, n2) = compile(crank2);
    assert_ne!(n1, n2, "the misalignment premise");

    // Continuous machine, relinked crank 2.
    let mut cont = Interp::new();
    cont.link_intrinsics(&n1);
    assert!(cont.run(&b1).completed);
    let relinked = cont.relink_crank(&b2, &n2).expect("relinks");
    let o = cont.run(&relinked);
    assert!(o.completed, "continuous relinked crank: {:?}", o.halt);
    // 10 + 30 + 6
    assert_eq!(o.result, "46");

    // Store-resumed machine, same relink.
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed);
    let mut store = MemoryStore::new();
    drop(
        begin_store_session(m, &sig(), &mut store)
            .map_err(|(_, e)| e)
            .expect("begin"),
    );
    let mut session = resume_from_store(&store, &sig()).expect("resume");
    let relinked = session
        .machine_mut()
        .relink_crank(&b2, &n2)
        .expect("relinks on resumed machine");
    let o = session.machine_mut().run(&relinked);
    assert!(o.completed, "resumed relinked crank: {:?}", o.halt);
    assert_eq!(o.result, "46", "resumed equals continuous through a relink");
    // The extended table persists: checkpoint, resume again, and run
    // ANOTHER misaligned crank against the grown table.
    checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoint");
    drop(session);
    let mut session = resume_from_store(&store, &sig()).expect("resume 2");
    let crank3 = "var w; var q; var t; t = q + w; t";
    let (b3, n3) = compile(crank3);
    let relinked = session
        .machine_mut()
        .relink_crank(&b3, &n3)
        .expect("relinks against the extended table");
    let o = session.machine_mut().run(&relinked);
    assert!(o.completed);
    // q=10, w=30 persisted under their appended ids.
    assert_eq!(o.result, "40", "appended names persisted with their values");
}

/// G2's edges after the id-space split. A machine holding a MINTED
/// symbol-key id used to refuse table extension outright (the appended
/// ids came out of the shared runtime-intern range); symbol keys now
/// mint top-down from `u16::MAX`, so extension cannot collide and the
/// relink proceeds — the symbol-keyed property keeps answering through
/// the extended table. What remains fail-closed: bytecode referencing
/// ids beyond its own compiled table is refused as malformed, and
/// nothing runs on that refusal.
#[test]
fn relink_extends_past_minted_symbol_keys_and_refuses_malformed_bytecode() {
    use ironhorse_vm::RelinkError;

    let crank1 = "var o = 0; var sym = 0; var t = 0; \
                  o = {}; sym = Symbol.for('rk'); o[sym] = 5; t = o[sym]; t";
    let (b1, n1) = compile(crank1);
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    let o = m.run(&b1);
    assert!(o.completed, "mint crank: {:?}", o.halt);
    assert_eq!(o.result, "5");

    // An EXTENDING crank relinks despite the minted symbol key…
    let (b2, n2) = compile("var q = 1; q");
    let relinked = m
        .relink_crank(&b2, &n2)
        .expect("extension no longer collides with symbol-key ids");
    assert!(m.run(&relinked).completed);
    // …and the symbol-keyed property still reads correctly after it.
    let crank3 = "var back = 0; back = o[sym]; back";
    let (b3, n3) = compile(crank3);
    let relinked3 = m.relink_crank(&b3, &n3).expect("relinks");
    let o3 = m.run(&relinked3);
    assert!(o3.completed, "post-extension read: {:?}", o3.halt);
    assert_eq!(o3.result, "5", "symbol-keyed slot kept its id across extension");

    // Malformed: bytecode compiled against ONE name, relinked with an
    // EMPTY claimed table — its id 1 has no mapping.
    let mut fresh = Interp::new();
    let (b4, n4) = compile("var only = 3; only");
    fresh.link_intrinsics(&n4);
    assert_eq!(
        fresh.relink_crank(&b4, &[]),
        Err(RelinkError::MalformedBytecode),
        "an id beyond the claimed table is refused",
    );
}

/// The wave-4 P1 hazard, now LIFTED by the id-space unification: a
/// machine that used a runtime-interned property key (`o[expr]`
/// computed string key, or `o[sym]` symbol key) checkpoints and
/// resumes correctly. String keys append to the persisted NAME table;
/// symbol keys travel in the SYMB table (counter + id→descriptor
/// pairs). The lock is a resumed-vs-uninterrupted twin on both kinds:
/// the resumed machine reads the same values back through the same
/// keys, which is exactly what the old fail-closed refusal existed to
/// prevent going silently wrong.
#[test]
fn interned_property_keys_round_trip_through_the_store() {
    // Symbol used as a PROPERTY key mints a symbol_key_ids intern.
    let mint = "var o = 0; var s = 0; var t = 0; \
                o = {}; s = Symbol('k'); o[s] = 1; t = o[s]; t";
    let read = "var o; var s; var t; t = o[s]; t";
    let (b_mint, n_mint) = compile(mint);
    let (b_read, _) = compile(read);

    // Uninterrupted twin.
    let mut twin = Interp::new();
    twin.link_intrinsics(&n_mint);
    assert!(twin.run(&b_mint).completed);
    let twin_read = twin.run(&b_read);
    assert!(twin_read.completed);
    assert_eq!(twin_read.result, "1");

    // Suspended twin: begin, checkpoint after the mint, resume, read.
    let mut m = Interp::new();
    m.link_intrinsics(&n_mint);
    let mut store = MemoryStore::new();
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("begin");
    let o = session.machine_mut().run(&b_mint);
    assert!(o.completed, "mint crank: {:?}", o.halt);
    assert!(
        session.machine_mut().stored_runtime_intern().is_some(),
        "the symbol property key STORED a symbol-key id in a slot"
    );
    checkpoint_to_store(&mut session, &sig(), &mut store).expect("symbol keys checkpoint");
    drop(session);
    let mut resumed = resume_from_store(&store, &sig()).expect("symbol keys resume");
    let r = resumed.machine_mut().run(&b_read);
    assert!(r.completed, "resumed read: {:?}", r.halt);
    assert_eq!(r.result, "1", "the stored symbol id re-binds to the same descriptor");

    // Computed STRING key across an incremental checkpoint: the minted
    // name rides the NAME table.
    let (b0, names) = compile("var o = 0; var k = 0; var t = 0; o = {}; k = 'x'; t = 7; t");
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    assert!(m.run(&b0).completed);
    let mut store = MemoryStore::new();
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("clean begin");
    let (b1, _) = compile("var o; var k; var t; o[k] = 5; t = o[k]; t");
    let o = session.machine_mut().run(&b1);
    assert!(o.completed, "compute-key crank: {:?}", o.halt);
    checkpoint_to_store(&mut session, &sig(), &mut store)
        .expect("a computed-string-key crank checkpoints");
    drop(session);
    let mut resumed = resume_from_store(&store, &sig()).expect("resume");
    let (b2, _) = compile("var o; var k; var t2; t2 = o[k]; t2");
    let r = resumed.machine_mut().run(&b2);
    assert!(r.completed, "resumed read: {:?}", r.halt);
    assert_eq!(r.result, "5", "the minted name resolved to the same id after resume");
}

/// Review wave 5: interning happens on a LOOKUP, so a program that
/// only MISSES a property mints an id and stores nothing. Such a
/// machine has always been persistable in principle — the id names
/// nothing in the heap, so a resume has nothing to alias — but the
/// wave-4 gate asked the mint counter and refused it anyway.
///
/// That over-refusal was not a nuisance, it was a correctness bug one
/// level up: the refusal came out of `checkpoint_to_store`, whose
/// caller rewinds the crank, so whether the program's effects survived
/// depended on `checkpoint_every` — a store-configuration knob visible
/// in GUEST RESULTS. And because the counter never falls, the machine
/// stayed refused forever after one `hasOwnProperty` miss.
#[test]
fn a_read_miss_mints_an_id_but_stores_none_so_it_still_persists() {
    let (b0, n0) = compile(
        "var o = 0; var t = 0; o = {}; t = o.hasOwnProperty('zzz'); t",
    );
    let mut m = Interp::new();
    m.link_intrinsics(&n0);
    let o = m.run(&b0);
    assert!(o.completed, "miss crank: {:?}", o.halt);
    assert_eq!(o.result, "false");
    // The missing key WAS interned — as an appended NAME-table entry,
    // which is not a persistence hazard at all since the unification
    // (the old mint-counter gate refused exactly this shape). Boot and
    // link may legitimately mint symbol-key ids of their own (well-known
    // symbol properties), so no counter assertion is meaningful here;
    // what matters is that everything below persists.

    // It persists, and it keeps persisting across further misses.
    let mut store = MemoryStore::new();
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("a mint-without-store machine begins a session");
    let (b1, _) = compile("var o; var t; t = o.hasOwnProperty('qqq'); t");
    assert!(session.machine_mut().run(&b1).completed);
    assert_eq!(
        checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoints"),
        2,
    );

    // And relinking still works, including the table-EXTENDING case the
    // old gate refused outright.
    let (b2, n2) = compile("var o = 0; var fresh = 0; fresh = 9; fresh");
    let relinked = session
        .machine_mut()
        .relink_crank(&b2, &n2)
        .expect("a table-extending crank relinks on a mint-only machine");
    let out = session.machine_mut().run(&relinked);
    assert!(out.completed, "relinked crank: {:?}", out.halt);
    assert_eq!(out.result, "9");
}

/// Review wave 5's image-witness principle, carried into the
/// id-space audit: the witness is the IMAGE's content, not any live
/// counter — a stored property id outside BOTH key tables (the name
/// table and the symbol-key table) maps to nothing, can only come from
/// crafted or torn bytes (or a pre-unification build that persisted a
/// then-unresumable intern), and is refused as corrupt at adoption
/// rather than laundered into a session's checkpoints.
#[test]
fn the_persistence_audit_reads_the_image_not_the_mint_counter() {
    use ironhorse_snapshot::image::MachineImage;
    use ironhorse_snapshot::store::{image_to_batch, MemoryStore};

    let (b0, n0) = compile("var o = 0; var t = 0; o = { a: 1 }; t = o.a; t");
    let mut m = Interp::new();
    m.link_intrinsics(&n0);
    assert!(m.run(&b0).completed);
    let clean: MachineImage = m.snapshot_image(&sig());
    assert_eq!(clean.stored_unregistered_key_id(), None, "the fixture is clean");

    // Poison one LIVE slot's key id past the program table — the shape
    // a machine that stored `o[expr]` would have had, and the shape an
    // older build could have written.
    let past = clean.names.len() as u16 + 1;
    let victim = (0..clean.slots.len())
        .find(|i| !clean.slot_free.contains(&(*i as u32)) && clean.slots[*i].id != 0)
        .expect("the fixture has a keyed live slot");
    let mut poisoned = clean.clone();
    poisoned.slots[victim].id = past;
    assert_eq!(
        poisoned.stored_unregistered_key_id(),
        Some(past),
        "the image reports the stored id whatever a counter would say"
    );

    // The same id on a FREE slot is NOT a hazard: the record is stale,
    // nothing reaches it, and counting it would refuse a machine whose
    // offending key the collector already reclaimed.
    let mut freed = poisoned.clone();
    freed.slot_free.push(victim as u32);
    freed.slot_live -= 1;
    assert_eq!(freed.stored_unregistered_key_id(), None, "a free slot names nothing");

    let poisoned_bytes = write_machine(&poisoned);
    assert_eq!(
        from_snapshot_bytes(&poisoned_bytes, &sig()).err(),
        Some(ironhorse_snapshot::format::SnapshotError::Corrupt(
            "stored property id outside the name and symbol-key tables",
        )),
        "a poisoned container cannot restore directly",
    );

    // The blob→store adoption path refuses it too.
    let mut store = MemoryStore::new();
    assert_eq!(
        ironhorse_snapshot::store::import_from_container(
            &poisoned_bytes,
            &sig(),
            &mut store,
        ),
        Err(StoreError::Snapshot(
            ironhorse_snapshot::format::SnapshotError::Corrupt(
                "stored property id outside the name and symbol-key tables",
            ),
        )),
        "a poisoned container cannot be adopted into a store",
    );

    // And a store that already holds one — committed straight, as a
    // build predating the gate would have — is refused at the eager
    // resume rather than laundered into this session's checkpoints.
    let mut store = MemoryStore::new();
    store
        .commit(&image_to_batch(&poisoned, 1, ""))
        .expect("the raw commit models an older writer");
    assert_eq!(
        resume_from_store(&store, &sig()).err(),
        Some(StoreError::Snapshot(
            ironhorse_snapshot::format::SnapshotError::Corrupt(
                "stored property id outside the name and symbol-key tables",
            ),
        )),
        "a poisoned store is not adopted",
    );
}

/// Wave-4 P1 lock: a relinked crank that FIRST references a built-in
/// (intrinsic global, prototype method, well-known symbol) gets it
/// bound — relink installs the APPENDED ids' intrinsic bindings, not
/// just the name table. Before the fix these threw ("undefined
/// variable") or silently read undefined. crank1 never mentions the
/// built-in, so its id is appended by the relink; the assertion is the
/// known-correct JS value.
#[test]
fn relink_binds_newly_referenced_intrinsics() {
    // (crank1 without the built-in, crank2 first mentioning it, expected)
    let cases = [
        // Intrinsic global (Math) + method (max), appended by relink.
        ("var x = 5; x", "var x; var t; t = Math.max(x, 2); t", "5"),
        // Prototype method (Array.prototype.indexOf), appended by relink.
        (
            "var x = 5; x",
            "var x; var arr; var t; arr = [10, 20, 30]; t = arr.indexOf(20); t",
            "1",
        ),
        // A constructor global reached via typeof.
        ("var x = 5; x", "var x; var t; t = typeof Symbol; t", "function"),
    ];
    for (c1, c2, expect) in cases {
        let (b1, n1) = compile(c1);
        let (b2, n2) = compile(c2);
        assert_ne!(n1, n2, "the built-in name is genuinely appended: {c2}");
        let mut m = Interp::new();
        m.link_intrinsics(&n1);
        assert!(m.run(&b1).completed);
        let relinked = m.relink_crank(&b2, &n2).expect("relink");
        let got = m.run(&relinked);
        assert!(got.completed, "relinked {c2}: {:?}", got.halt);
        assert_eq!(got.result, expect, "relinked crank binds the built-in: {c2}");
    }
}
