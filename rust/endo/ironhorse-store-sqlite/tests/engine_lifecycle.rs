//! Engine-level coverage of the SQLite backend: real JavaScript,
//! compiled by the pure-Rust `ironhorse-compile` pipeline, executed
//! crank by crank on machines that **suspend into and resume from the
//! SQLite store between every crank** (the sleepy-worker shape, with a
//! full last-connection close each time), against an uninterrupted
//! baseline machine.
//!
//! The locks per scenario, all against the baseline:
//! - every crank's completion value matches, crank by crank;
//! - the final computron count matches (the meter continued exactly
//!   through every store round-trip);
//! - after every checkpoint the store equals the live machine
//!   (`store_to_image == snapshot_image`);
//! - the final store's canonical export is **byte-identical** to the
//!   blob the baseline machine writes — total-state equality, not just
//!   observable equality.
//!
//! Fixture discipline: each scenario asserts its baseline completion
//! against a literal expected value first, so a fixture the engine
//! cannot yet run fails loudly at the baseline, never as a store-attributed
//! divergence. The first crank installs the realm's symbols with
//! `link_intrinsics`; every later independently compiled crank passes through
//! `relink_crank`, the production boundary that maps its local symbol ids into
//! the retained realm and keeps its function bytecode alive.

use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, resume_from_store, MachineSnapshot,
};
use ironhorse_snapshot::store::{export_to_container, store_to_image, StoreError};
use ironhorse_snapshot::Signature;
use ironhorse_store_sqlite::SqliteHeapStore;
use ironhorse_vm::{parse_symbols, Interp, CHUNK_EXTENT_BYTES, SLOTS_PER_PAGE};

mod common;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("fixture compiles");
    (bytecode, parse_symbols(&symbols))
}

fn tmp_dir(name: &str) -> common::TempDir {
    common::TempDir::new(&format!("ironhorse-sqlite-engine-{name}"))
}

/// Run `cranks` uninterrupted on one machine, then again with a full
/// SQLite suspend/close/reopen/resume between every crank, and hold
/// the scenario locks. Returns the baseline's final completion value
/// so callers can assert their literal expectation.
fn run_scenario(name: &str, cranks: &[&str]) -> String {
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks.iter().map(|s| compile(s)).collect();

    // Baseline: one machine, never suspended.
    let mut baseline = Interp::new();
    baseline.link_intrinsics(&compiled[0].1);
    let mut baseline_outcomes = Vec::new();
    for (i, (bytecode, names)) in compiled.iter().enumerate() {
        let runnable = if i == 0 {
            bytecode.clone()
        } else {
            baseline
                .relink_crank(bytecode, names)
                .expect("baseline crank relinks")
        };
        let outcome = baseline.run(&runnable);
        assert!(
            outcome.completed,
            "[{name}] baseline crank {} completes (halt: {:?})",
            i + 1,
            outcome.halt
        );
        baseline_outcomes.push(outcome);
    }

    // Store lifecycle: crank 1 on a fresh machine, then a full
    // suspend/resume cycle (checkpoint, close, reopen, resume) around
    // every subsequent crank.
    let dir = tmp_dir(name);
    let path = dir.join("worker-heap.sqlite");

    let mut store = SqliteHeapStore::open(&path).unwrap();
    let mut m0 = Interp::new();
    m0.link_intrinsics(&compiled[0].1);
    let outcome = m0.run(&compiled[0].0);
    assert_eq!(
        outcome.result, baseline_outcomes[0].result,
        "[{name}] crank 1 result"
    );
    let mut session = begin_store_session(m0, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("begin session");
    assert_eq!(
        store_to_image(&store).unwrap(),
        session.machine().snapshot_image(&sig()),
        "[{name}] store equals live machine after the full write"
    );

    for (i, (bytecode, names)) in compiled.iter().enumerate().skip(1) {
        // Sleep: drop the machine, close the database fully.
        drop(session);
        store.close().expect("full close");

        // Wake: reopen, resume, run the next crank.
        store = SqliteHeapStore::open(&path).unwrap();
        session = resume_from_store(&store, &sig()).expect("resumes");
        let runnable = session
            .machine_mut()
            .relink_crank(bytecode, names)
            .expect("resumed crank relinks");
        let outcome = session.machine_mut().run(&runnable);
        assert!(
            outcome.completed,
            "[{name}] resumed crank {} completes",
            i + 1
        );
        assert_eq!(
            outcome.result,
            baseline_outcomes[i].result,
            "[{name}] crank {} result equals the uninterrupted run",
            i + 1
        );
        assert_eq!(
            outcome.computrons,
            baseline_outcomes[i].computrons,
            "[{name}] crank {} cumulative computrons equal the uninterrupted run",
            i + 1
        );

        let epoch =
            checkpoint_to_store(&mut session, &sig(), &mut store).expect("incremental checkpoint");
        assert_eq!(epoch as usize, i + 1, "[{name}] one epoch per crank");
        assert_eq!(
            store_to_image(&store).unwrap(),
            session.machine().snapshot_image(&sig()),
            "[{name}] store equals live machine after checkpoint {}",
            i + 1
        );
    }

    // Total-state equality: the store's canonical export byte-equals
    // the blob the baseline machine itself writes.
    assert_eq!(
        export_to_container(&store).unwrap(),
        baseline
            .write_snapshot(&sig())
            .expect("quiescent machine snapshots"),
        "[{name}] final store export byte-equals the never-suspended machine's blob"
    );

    baseline_outcomes.last().unwrap().result.clone()
}

/// Runtime global + arithmetic across a suspend (the ledger's
/// GlobalProps/SymbolTables shape, through SQLite).
#[test]
fn globals_survive_sqlite_sleep_cycles() {
    let last = run_scenario("globals", &["var x = 5;", "x = x + 1;", "x + 10"]);
    assert_eq!(last, "16");
}

/// String state: chunk-arena content (UTF-16 payloads) round-trips,
/// growing across cranks; the final read composes pre- and
/// post-suspend string data.
#[test]
fn strings_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "strings",
        &["var s = 'seed';", "s = s + '-grow';", "s = s + s;", "s"],
    );
    assert_eq!(last, "seed-growseed-grow");
}

/// Object graphs: instance + property slots round-trip; properties
/// written before a suspend are read and mutated after it.
#[test]
fn object_properties_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "objects",
        &[
            "var o = { a: 1, b: 2 };",
            "o.a = o.a + o.b;",
            "o.b = o.a * 10;",
            "o.a + o.b",
        ],
    );
    assert_eq!(last, "33");
}

/// Property deletion frees a slot: the free list crosses the store
/// (order preserved) and a post-resume allocation reuses the freed
/// record exactly as the uninterrupted machine's does — locked by the
/// computron and export equalities in the scenario runner. The
/// standalone tail proves the fixture really populates the free list.
#[test]
fn free_list_reuse_survives_sqlite_sleep_cycles() {
    let last = run_scenario(
        "free-list",
        &[
            "var o = { a: 1, b: 2, c: 3, d: 0 };",
            "o.a; o.c; o.d; delete o.b;",
            "o.a; o.b; o.c; o.d = 4;",
            "o.b; o.a + o.c + o.d",
        ],
    );
    assert_eq!(last, "8");

    // The fixture genuinely frees a slot (delete detaches the property
    // record to the free list), so the scenario's export equality
    // really covers free-list round-trip and reuse.
    let (b1, names) = compile("var o = { a: 1, b: 2, c: 3, d: 0 };");
    let (b2, _) = compile("o.a; o.c; o.d; delete o.b;");
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    assert!(m.run(&b1).completed);
    assert!(m.run(&b2).completed);
    assert!(
        !m.slots.free_list().is_empty(),
        "delete must push the property record onto the free list"
    );
}

/// Closures resolved within their crank (the covered contract): a
/// closure-produced value crosses the suspend; no live closure does.
/// The follow-up crank anchors the function's internal names so its
/// symbol set matches crank 1's.
#[test]
fn closure_results_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "closure-results",
        &[
            "var y = (function (n) { var k = 2; return n * k; })(21);",
            "var n; var k; y + 1",
        ],
    );
    assert_eq!(last, "43");
}

/// Arrow-specific function metadata and closure-environment captures survive
/// a full SQLite close/reopen cycle. This covers all three lexical bindings
/// stored by `STORE_ARROW`: `this`, `new.target`, and the method home object
/// used by `super`.
#[test]
fn arrow_lexical_captures_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "arrow-captures",
        &[
            "var receiver = { x: 7, make() { return () => this.x; } }; \
             var heldThis = receiver.make(); \
             var F = function () { return () => new.target; }; \
             var heldTarget = new F(); \
             var base = { x: 3 }; \
             var object = { m() { return () => super.x; } }; \
             Object.setPrototypeOf(object, base); \
             var heldSuper = object.m();",
            "var receiver; receiver.x; receiver.make; \
             var heldThis; var F; var heldTarget; \
             var base; base.x; var object; object.m; Object.setPrototypeOf; \
             var heldSuper; \
             heldThis() + ':' + (heldTarget() === F) + ':' + heldSuper()",
        ],
    );
    assert_eq!(last, "7:true:3");
}

/// A heap wide enough to span many slot pages: thousands of
/// instance/property slots from an object-churn loop, verified after
/// a sleep cycle. Asserts the store really carries multiple pages so
/// the scenario cannot silently shrink below its purpose.
#[test]
fn multi_page_heap_survives_sqlite_sleep_cycles() {
    let last = run_scenario(
        "multi-page",
        &[
            "var last = { v: 0 }; var i = 0; for (i = 0; i < 2000; i = i + 1) { last = { v: i }; }",
            "var i; last.v + 1",
        ],
    );
    assert_eq!(last, "2000");

    // Independently confirm the fixture's heap really is multi-page.
    let (bytecode, names) = compile(
        "var last = { v: 0 }; var i = 0; for (i = 0; i < 2000; i = i + 1) { last = { v: i }; }",
    );
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    assert!(m.run(&bytecode).completed);
    assert!(
        m.slots.capacity() > 4 * SLOTS_PER_PAGE,
        "fixture must span several slot pages, has {} records",
        m.slots.capacity()
    );
}

/// A chunk arena wide enough to span multiple extents: doubling string
/// concatenation. Verified after sleep cycles, with the extent span
/// independently confirmed.
#[test]
fn multi_extent_chunks_survive_sqlite_sleep_cycles() {
    let doubler =
        "var s = '0123456789abcdef'; var i = 0; for (i = 0; i < 12; i = i + 1) { s = s + s; }";
    let last = run_scenario("multi-extent", &[doubler, "s = s + 'END';", "'ok'"]);
    assert_eq!(last, "ok");

    let (bytecode, names) = compile(doubler);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    assert!(m.run(&bytecode).completed);
    assert!(
        m.chunks.byte_size() > 2 * CHUNK_EXTENT_BYTES as usize,
        "fixture must span several chunk extents, has {} bytes",
        m.chunks.byte_size()
    );
}

/// A long lifecycle: many cranks, one epoch per crank, every wake from
/// a fully closed database. The per-crank symbol numbering is
/// identical by construction (every crank is the same source).
#[test]
fn many_epoch_lifecycle_tracks_uninterrupted() {
    let mut cranks: Vec<&str> = vec!["var x = 1;"];
    for _ in 0..8 {
        cranks.push("x = x + x;");
    }
    cranks.push("x");
    let last = run_scenario("many-epochs", &cranks);
    assert_eq!(last, "256");
}

/// An interrupted lifecycle can be told apart from a corrupted one: a
/// scenario against a store whose file was truncated mid-life fails
/// closed at open/validate, never resumes wrong.
#[test]
fn truncated_database_fails_closed_not_wrong() {
    let dir = tmp_dir("truncate");
    let path = dir.join("worker-heap.sqlite");
    let (bytecode, names) = compile("var x = 5;");

    let mut store = SqliteHeapStore::open(&path).unwrap();
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    assert!(m.run(&bytecode).completed);
    drop(
        begin_store_session(m, &sig(), &mut store)
            .map_err(|(_, e)| e)
            .unwrap(),
    );
    store.close().unwrap();

    // Truncate the closed, self-contained database file.
    let bytes = std::fs::read(&path).unwrap();
    std::fs::write(&path, &bytes[..bytes.len() / 3]).unwrap();

    match SqliteHeapStore::open(&path).and_then(|s| resume_from_store(&s, &sig()).map(|_| ())) {
        Err(StoreError::Io(_)) | Err(StoreError::Snapshot(_)) | Err(StoreError::Empty) => {}
        Err(other) => panic!("unexpected error shape: {other:?}"),
        Ok(()) => panic!("a truncated database must not resume"),
    }
}

/// The single-writer-per-path model is enforced, not assumed
/// (collaborator-review follow-up): under `locking_mode=EXCLUSIVE`
/// the first connection to touch the file holds it, so a second
/// opener fails closed at its first query (the application_id gate)
/// with SQLITE_BUSY after the busy timeout, instead of silently
/// racing the writer. ~5s: the second opener waits out busy_timeout.
#[test]
fn second_opener_fails_closed_under_exclusive_locking() {
    let dir = common::TempDir::new(&format!(
        "ironhorse-sqlite-exclusive-{}",
        std::process::id()
    ));
    let path = dir.join("heap.sqlite");

    let first = ironhorse_store_sqlite::SqliteHeapStore::open(&path).expect("first opener");
    match ironhorse_store_sqlite::SqliteHeapStore::open(&path) {
        Err(_) => {}
        Ok(_) => panic!("second opener must fail closed while the first holds the file"),
    }
    drop(first);
}

/// Side-table ledger (G1) through SQLite: an array, a Map, and a
/// `Symbol.for` registration built before the FIRST sleep keep
/// answering — and keep MUTATING — across two more sleep cycles,
/// tracking the uninterrupted baseline. Every crank opens with the
/// same var/anchor prelude so all three compile to the identical
/// symbol table (the bucket-ordered contract).
#[test]
fn side_tables_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "side-tables",
        &[
            "var arr = []; var m = new Map(); var sym = 0; var a = 0; var i = 0; var t = 0; var v = 0; \
             m.set; m.get; arr.length; Symbol.for; \
             a = { v: 1 }; sym = Symbol.for('led'); \
             for (i = 0; i < 8; i = i + 1) { arr[i] = i + 1; } \
             m.set(a, 50); m.set(sym, 500); t = 7;",
            "var arr; var m; Map; var sym; var a; var i; var t; var v; \
             m.set; m.get; arr.length; Symbol.for; \
             arr[8] = 9; m.set(a, m.get(a) + 1); t = 7;",
            "var arr; var m; Map; var sym; var a; var i; var t; var v; \
             m.set; m.get; arr.length; Symbol.for; \
             t = arr.length + arr[8] + m.get(a) + m.get(Symbol.for('led')); t",
        ],
    );
    // 9 + 9 + 51 + 500
    assert_eq!(last, "569");
}

/// The GRADUATED carry matrix, through the full close/reopen lifecycle.
///
/// This file's header used to say a live closure or generator held
/// ACROSS a suspend was deliberately absent, because those rows were
/// the ledger's `Pending` remainder. That is no longer true: the
/// callability cluster, generators, Intl bound functions, private
/// elements and disposable stacks all graduated. Until now they were
/// exercised only against the reference backends and the shared
/// metamorphic suite, which holds ONE connection open for a whole
/// scenario — so nothing ran a carried row through a
/// last-connection close, WAL folding, `SqliteHeapStore::init`, a lost
/// and reconstructed `root_cache`, a rebuilt `edge_pairs`, and a lazy
/// read after reopen.
///
/// `run_scenario` is that lifecycle, and its locks are the strong ones:
/// every crank's value against an uninterrupted baseline, the final
/// computron count, `store_to_image == snapshot_image` after every
/// checkpoint, and a final container export byte-identical to the
/// baseline's blob.
fn carry_scenario(name: &str, mentions: &str, bodies: &[&str]) -> String {
    // Bare re-declarations do not clobber, so one preamble opens every
    // crank; the dead block anchors the member and parameter names that
    // otherwise appear in only one of them. Program-symbol ids are
    // POSITIONAL, so an unanchored name shifts every id after it.
    let decls = "var a; var b; var C; var f; var g; var inst; var it; var k; var nf; \
                 var o; var q; var s; var sg; var seg; var t; var v; var x; ";
    let cranks: Vec<String> = bodies
        .iter()
        .map(|body| {
            format!(
                "{decls} if (0) {{ (function (x, k, v) {{ return x + k + v; }}); {mentions} }} {body}"
            )
        })
        .collect();
    let refs: Vec<&str> = cranks.iter().map(String::as_str).collect();
    // Keep these broad carry-matrix rows on the aligned-symbol fast path.
    // A separate lifecycle regression below deliberately reorders and extends
    // the symbol table to exercise production relinking across reopen.
    let anchor = compile(refs[0]).1;
    for (i, crank) in refs.iter().enumerate().skip(1) {
        assert_eq!(
            compile(crank).1,
            anchor,
            "[{name}] crank {} must intern exactly crank 1's symbols, in order",
            i + 1
        );
    }
    run_scenario(name, &refs)
}

#[test]
fn carried_closure_survives_reordered_and_extended_symbol_tables() {
    let cranks = [
        "var saved; var out; saved = function (alpha) { return alpha + 1; }; out = 0;",
        "var fresh; var out; var saved; fresh = { marker: 40 }; out = saved(fresh.marker); out",
        "var another; var saved; var out; another = 1; out = saved(out + another); out",
    ];
    let symbols: Vec<_> = cranks.iter().map(|source| compile(source).1).collect();
    assert_ne!(symbols[0], symbols[1], "crank 2 must require relinking");
    assert_ne!(symbols[1], symbols[2], "crank 3 must require relinking");
    assert!(
        symbols[1].iter().any(|name| name == "fresh")
            && symbols[1].iter().any(|name| name == "marker"),
        "crank 2 must extend the persisted realm's symbol set"
    );

    assert_eq!(run_scenario("carry-relinked-closure", &cranks), "43");
}

#[test]
fn the_callability_cluster_survives_sqlite_sleep_cycles() {
    let last = carry_scenario(
        "carry-functions",
        "f.bind(o, 0); o.k;",
        &[
            "f = function (x) { return x + this.k; }; o = { k: 10 }; b = f.bind(o, 5); t = 7;",
            "t = b(); o.k = 20; t",
            "t = b(); t",
        ],
    );
    assert_eq!(last, "25");
}

#[test]
fn a_suspended_generator_survives_sqlite_sleep_cycles() {
    let last = carry_scenario(
        "carry-generators",
        "it.next().value; it.next().done;",
        &[
            "g = function* () { var x = 1; yield x; yield x + 1; yield x + 2; }; \
             it = g(); t = it.next().value; t",
            "t = it.next().value; t",
            "t = it.next().value + (it.next().done ? 100 : 0); t",
        ],
    );
    assert_eq!(last, "103");
}

#[test]
fn intl_bound_functions_survive_sqlite_sleep_cycles() {
    // Also the SQLite arm of the rebound-Intl ordering fix: `b` is a
    // guest bind whose TARGET travels in `IBFN`, the shape that used to
    // checkpoint and then never resume.
    let last = carry_scenario(
        "carry-intl-bound",
        "new Intl.NumberFormat('en'); nf.format(0); f.bind(null);",
        &[
            "nf = new Intl.NumberFormat('en'); f = nf.format; b = f.bind(null); t = 7;",
            "t = f(0.5); t",
            "t = b(0.25) + ':' + (nf.format === f); t",
        ],
    );
    assert_eq!(last, "0.25:true");
}

#[test]
fn private_elements_and_disposal_survive_sqlite_sleep_cycles() {
    let last = carry_scenario(
        "carry-private-disposal",
        "(class { #n = 0; get n() { return this.#n; } set n(v) { this.#n = v; } }); \
         new C(); inst.n; new DisposableStack(); s.defer(null); s.dispose();",
        &[
            "C = class { #n = 3; get n() { return this.#n; } set n(v) { this.#n = v; } }; \
             inst = new C(); s = new DisposableStack(); \
             s.defer(function () { v = 9; }); v = 0; t = 7;",
            "t = inst.n; inst.n = inst.n + 4; t",
            "s.dispose(); t = inst.n + v; t",
        ],
    );
    assert_eq!(last, "16");
}

#[test]
fn boot_minted_iterator_natives_survive_sqlite_sleep_cycles() {
    // The SQLite arm of the boot-mint fix: these three `@@iterator`
    // natives are re-derived by a fresh boot rather than carried, so
    // they are exactly the state a close/reopen could get wrong.
    let last = carry_scenario(
        "carry-boot-natives",
        "new Intl.Segmenter('en'); sg.segment('ab'); seg[Symbol.iterator]; \
         for (var q of seg) { k = q; }",
        &[
            "sg = new Intl.Segmenter('en'); seg = sg.segment('ab'); t = 7;",
            "t = typeof seg[Symbol.iterator]; t",
            "k = 0; for (var q of seg) { k = k + 1; } t = k; t",
        ],
    );
    assert_eq!(last, "2");
}

#[test]
fn instanceof_intrinsics_and_custom_handlers_survive_sqlite_sleep_cycles() {
    // `%Function.prototype%` and the identity of its `@@hasInstance` method
    // are boot-rebuilt, while the lazily installed symbol property and a
    // guest custom handler travel through the persisted heap/symbol tables.
    let last = carry_scenario(
        "carry-has-instance",
        "Function.prototype[Symbol.hasInstance]; o[Symbol.hasInstance]; \
         inst instanceof C; inst instanceof o;",
        &[
            "C = function () {}; inst = new C(); o = {}; t = 7;",
            "o[Symbol.hasInstance] = function (v) { return v === inst; }; \
             t = typeof Function.prototype[Symbol.hasInstance]; t",
            "t = (inst instanceof C) + ':' + (inst instanceof o); t",
        ],
    );
    assert_eq!(last, "true:true");
}

#[test]
fn abstract_typed_array_hierarchy_survives_sqlite_sleep_cycles() {
    // `%TypedArray%` and `%TypedArray.prototype%` are boot-rebuilt shared
    // intermediates. Concrete constructors, prototypes, instances, and their
    // inherited methods must retain those links across a full close/reopen.
    let last = carry_scenario(
        "carry-typed-array-hierarchy",
        "Object.getPrototypeOf(Int8Array); Object.getPrototypeOf(Uint8Array); \
         C.prototype; inst.copyWithin; inst.toLocaleString; inst.length; \
         inst instanceof C; Object.prototype.toString.call(inst); \
         Number.prototype.toLocaleString; BigInt.prototype.toLocaleString;",
        &[
            "C = Object.getPrototypeOf(Int8Array); \
             o = Object.getPrototypeOf(Int8Array.prototype); \
             inst = new Int8Array([1, 2, 3]); t = 7;",
            "inst.copyWithin(1, 0, 1); \
             t = (Object.getPrototypeOf(Uint8Array) === C) + ':' + \
                 (C.prototype === o); t",
            "t = (inst instanceof C) + ':' + inst[1] + ':' + \
                 (Object.getPrototypeOf(inst) === Int8Array.prototype) + ':' + \
                 Object.prototype.toString.call(inst) + ':' + \
                 inst.toLocaleString() + ':' + \
                 (1234).toLocaleString() + ':' + \
                 (1234n).toLocaleString(); t",
        ],
    );
    assert_eq!(
        last,
        "true:1:true:[object Int8Array]:1,1,3:1,234:1,234"
    );
}

#[test]
fn array_sort_and_change_by_copy_natives_survive_sqlite_sleep_cycles() {
    // The methods are boot-rebuilt natives, while the source Array and its
    // compact element side table cross a full close/reopen before each method.
    // The join calls ensure Set/CreateDataProperty kept ordinary array elements
    // compact instead of degrading them into unsupported sparse rows.
    let last = carry_scenario(
        "carry-array-sort",
         "Array.prototype.sort; Array.prototype.toSorted; a.sort; a.toSorted; \
         Array.prototype.slice; a.slice; Array.prototype.concat; a.concat; \
         Array.prototype.push; Array.prototype.pop; \
         Array.prototype.with; Array.prototype.toReversed; \
         Array.prototype.toSpliced; Array.prototype.with.name; \
         Array.prototype.sort.call; Uint8Array; Reflect.ownKeys; Reflect.set; \
         Object.prototype.hasOwnProperty; Symbol.isConcatSpreadable; \
         a.join; a.length; 'con'; 'structor'; \
         (function (y, z) { return y; });",
        &[
            "a = [3, 1, 2]; k = 'con' + 'structor'; delete Array.prototype[k]; t = 7;",
            "a.sort(function (x, y) { return x - y; }); t = a.join(','); t",
            "b = a.toSorted(function (x, y) { return y - x; }); \
             t = b.join(',') + ':' + a.join(','); t",
            "v = b.with(1, 9); s = v.toReversed(); \
             o = s.toSpliced(1, 1, 8); \
             q = [1, , 3]; \
             f = {0: 4, length: 1}; f[Symbol.isConcatSpreadable] = true; \
             v = a.concat(f); \
             t = o.join(',') + ':' + Array.prototype.with.name + ':' + \
                 Array.prototype.with.length + ':' + \
                 Array.prototype.toReversed.name + ':' + \
                 Array.prototype.toReversed.length + ':' + \
                 Array.prototype.toSpliced.name + ':' + \
                 Array.prototype.toSpliced.length; t",
            "inst = new Uint8Array([2, 1]); \
             Array.prototype.sort.call(inst, function (x, y) { return x - y; }); \
             g = []; Reflect.set(inst, '0', 7, g); \
             q = q.slice(0, 3); \
             f = {length: 4294967297}; f[4294967296] = 5; \
             b = {length: 0}; Array.prototype.push.call(b, 6, 7); \
             inst[Symbol.isConcatSpreadable] = true; z = [0].concat(inst); \
             delete inst[Symbol.isConcatSpreadable]; \
             t = inst.join(',') + ':' + Reflect.ownKeys(inst).join(',') + ':' + t; t",
            "t = inst.join(',') + ':' + Reflect.ownKeys(inst).join(',') + ':' + t + ':' + \
                 q[0] + ':' + Object.prototype.hasOwnProperty.call(q, 1) + ':' + q[2] + ':' + \
                 Array.prototype.slice.name + ':' + Array.prototype.slice.length + ':' + \
                 g[0] + ':' + g.length + ':' + \
                 Array.prototype.concat.name + ':' + Array.prototype.concat.length + ':' + \
                 v.join(',') + ':' + Array.prototype.slice.call(f, 4294967296).join(',') + ':' + \
                 Object.prototype.hasOwnProperty.call(Array.prototype, k) + ':' + \
                 Array.prototype.pop.call(b) + ':' + b.length + ':' + b[0] + ':' + z.join(','); t",
        ],
    );
    assert_eq!(
        last,
        "1,2:0,1:1,2:0,1:1,8,3:with:2:toReversed:0:toSpliced:2:1:false:3:slice:2:7:1:concat:1:1,2,3,4:5:false:7:1:6:0,1,2"
    );
}

#[test]
fn tagged_template_registry_survives_sqlite_sleep_cycles() {
    // The hidden realm template registry lives in the ordinary boot heap.
    // This exercises both halves of its contract through real full closes:
    // a retained function's parse site keeps object identity and frozen
    // descriptors, while a separately compiled later crank with the same
    // source spelling receives a fresh site key.
    let last = run_scenario(
        "carry-tagged-template-registry",
        &[
            "var saved; function tag(strings){saved=saved||strings;return strings} \
             function run(v){return tag`head${v}tail`} run(1)===saved",
            "var s=run(2),d=Object.getOwnPropertyDescriptor(s,'0'), \
             r=Object.getOwnPropertyDescriptor(s,'raw'); \
             ''+(s===saved)+':'+d.writable+d.configurable+':'+ \
             r.writable+r.enumerable+r.configurable",
            "var other=tag`head${3}tail`; other!==saved",
            "other!==saved",
        ],
    );
    assert_eq!(last, "true");
}

#[test]
fn the_promise_cluster_survives_sqlite_sleep_cycles() {
    // The SQLite arm of the schema-23 promise-cluster carry: a pending
    // promise with a stored resolver and a user reaction crosses two
    // close/reopen cycles, settles in the middle crank through the
    // restored resolver, and the late observation reads the value the
    // pre-sleep reaction computed.
    let last = carry_scenario(
        "carry-promises",
        "new Promise(function (a, b) { a(b); }); Promise.resolve(0); q.then(null);",
        &[
            "q = new Promise(function (a, b) { f = a; }); \
             q.then(function (v) { g = v + 1; }); g = 0; t = 7;",
            "f(41); t = typeof f; t",
            "t = g; t",
        ],
    );
    assert_eq!(last, "42");
}
