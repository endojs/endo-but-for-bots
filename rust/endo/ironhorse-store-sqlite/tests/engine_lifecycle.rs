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

#[test]
fn json_parsed_unicode_survives_sqlite_sleep_cycles() {
    let last = run_scenario(
        "json-unicode",
        &[
            "var parsed=JSON.parse('{\"😀\":\"\\\\ud800\",\"pair\":\"\\\\ud83d\\\\ude00\"}'); parsed.pair",
            "parsed['😀'].charCodeAt(0)+':'+parsed.pair.length+':'+parsed.pair.charCodeAt(0)+':'+parsed.pair.charCodeAt(1)",
            "JSON.stringify(parsed)",
        ],
    );
    assert_eq!(last, "{\"😀\":\"\\ud800\",\"pair\":\"😀\"}");
}

#[test]
fn unicode_case_results_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "unicode-case",
        &[
            "s = 'A\\u03A3 Stra\\u00DFe \\u0130'; lo = s.toLowerCase(); lo",
            "up = lo.toUpperCase(); up",
            "up.length + ':' + up.charCodeAt(1) + ':' + up.indexOf('SS') + ':' + \
             up.charCodeAt(up.length - 1)",
        ],
    );
    assert_eq!(last, "13:931:7:775");
}

#[test]
fn unicode_normalization_results_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "unicode-normalization",
        &[
            "s = 'e\\u0301 \\uFB03'; nfc = s.normalize(); nfc",
            "nfd = nfc.normalize('NFD'); compat = nfc.normalize('NFKC'); nfd",
            "nfc.charCodeAt(0) + ':' + nfd.charCodeAt(0) + ':' + \
             nfd.charCodeAt(1) + ':' + compat.slice(2)",
        ],
    );
    assert_eq!(last, "233:101:769:ffi");
}

#[test]
fn replace_all_results_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "replace-all",
        &[
            "plain = 'a-b-a'.replaceAll('a', 'xy'); plain",
            "empty = plain.replaceAll('', '.'); empty",
            "global = empty.replaceAll(/\\./g, '_'); global",
            "plain + ':' + empty + ':' + global",
        ],
    );
    assert_eq!(last, "xy-b-xy:.x.y.-.b.-.x.y.:_x_y_-_b_-_x_y_");
}

#[test]
fn string_raw_results_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "string-raw",
        &[
            "raw = String.raw({raw:['a','b','c']}, 1, 2); raw",
            "units = String.raw({raw:['\\ud800']}).charCodeAt(0); units",
            "raw + ':' + units.toString(16)",
        ],
    );
    assert_eq!(last, "a1b2c:d800");
}

#[test]
fn locale_string_results_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "locale-strings",
        &[
            "lower = 'Iİ'.toLocaleLowerCase('tr'); lower",
            "upper = 'iı'.toLocaleUpperCase('tr'); upper",
            "order = 'a'.localeCompare('Z') < 0; order",
            "lower + ':' + upper + ':' + order",
        ],
    );
    assert_eq!(last, "ıi:İI:true");
}

/// Stateful RegExp matching persists a UTF-16 `lastIndex` while its matcher
/// resumes over XS-style CESU-8, including an astral code point that spans two
/// code units. The final crank also covers non-ASCII regexp splitting after a
/// full SQLite close/reopen.
#[test]
fn unicode_regexp_state_survives_sqlite_sleep_cycles() {
    let last = run_scenario(
        "unicode-regexp",
        &[
            "var s='a'+String.fromCodePoint(0x1F600)+'é';var r=/./gu;var seen=r.exec(s)[0];",
            "seen=seen+':'+r.lastIndex+':'+r.exec(s)[0].length+':'+r.lastIndex;",
            "seen=seen+':'+r.exec(s)[0]+':'+r.lastIndex;",
            "seen+':'+s.split(/(?:)/u).length",
        ],
    );
    assert_eq!(last, "a:1:2:3:é:4:3");
}

/// Object graphs: instance + property slots round-trip; properties
/// written before a suspend are read and mutated after it.
#[test]
fn object_properties_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "objects",
        &[
            "var p = { inherited: 7 }; \
             var o = { __proto__: p, a: 1, b: 2, \
                 get c() { return this.a + this.inherited; } }; \
             var n = { __proto__: null, x: 2 };",
            "o.a = o.a + o.b;",
            "o.b = o.a * 10;",
            "(o.a + o.b + o.c) + ':' + (Object.getPrototypeOf(o) === p) + \
             ':' + (Object.getPrototypeOf(n) === null) + ':' + n.x",
        ],
    );
    assert_eq!(last, "43:true:true:2");
}

/// A boot-default name first produced at runtime must install the inherited
/// intrinsic before use, while a later deletion must remain deleted across
/// repeated SQLite close/reopen boundaries.
#[test]
fn computed_intrinsic_names_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "computed-intrinsic-names",
        &[
            "var k='hasOwn'+'Property';var f={}[k];var t=f.call({x:1},'x');t",
            "k='to'+'String';delete Object.prototype[k];t=7;t",
            "t=typeof ({})[k];t",
        ],
    );
    assert_eq!(last, "undefined");
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

/// A sloppy arguments object's mapped index retains its closure-cell edge in
/// the array side table. The parameter write happens only after a full SQLite
/// close/reopen, proving that both the mapping and its live value persist.
#[test]
fn mapped_arguments_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "mapped-arguments",
        &[
            "var updateMapped = (function (a) { var x = arguments; return function (v) { if (arguments.length) a = v; return x[0]; }; })(4);",
            "var updateMapped; updateMapped(9)",
            "var updateMapped; updateMapped()",
        ],
    );
    assert_eq!(last, "9");
}

/// Date calendar mutation crosses complete SQLite close/reopen cycles. The
/// later cranks first link the setter names after resume, covering both the
/// persisted `[[DateValue]]` row and deferred intrinsic installation.
#[test]
fn date_setters_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "date-setters",
        &[
            "var d = new Date(Date.UTC(1999, 11, 31, 23, 59, 59, 999));",
            "var d; d.setUTCMilliseconds(1001);",
            "var d; d.setUTCFullYear(2000);",
            "var d; d.toJSON()",
        ],
    );
    assert_eq!(last, "2000-01-01T00:00:00.001Z");
}

/// SES integrity state is carried entirely by arena flags. This scenario
/// proves visible property attributes (including RegExp's ordinary arbitrary-
/// valued `lastIndex`) and `petrify`'s read-only internal Date/Map marker
/// survive a complete SQLite close/reopen, rather than merely matching in an
/// uninterrupted process.
#[test]
fn harden_and_petrify_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "harden-petrify",
        &[
            "var child={x:1};var a=[child];harden(a);var m=new Map([['x',1]]);petrify(m);var d=new Date(0);petrify(d);var re=/a/g;re.lastIndex='1';harden(re);",
            "var child;var a;var m;var d;var re;var mapThrow=false;var dateThrow=false;var regexpThrow=false;a[0]=0;child.x=2;try{m.set('y',2)}catch(e){mapThrow=e instanceof TypeError}try{d.setTime(1)}catch(e){dateThrow=e instanceof TypeError}try{re.exec('ba')}catch(e){regexpThrow=e instanceof TypeError}Object.isFrozen(a)+':'+Object.isFrozen(child)+':'+child.x+':'+(a[0]===child)+':'+mapThrow+':'+m.size+':'+dateThrow+':'+d.getTime()+':'+regexpThrow+':'+Object.isFrozen(re)+':'+(re.lastIndex==='1')",
        ],
    );
    assert_eq!(last, "true:true:1:true:true:1:true:0:true:true:true");
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
        "f.bind(o, 0); b.call; b.apply; o.k; q.length;",
        &[
            "f = function (x, k, v) { return x + k + v + this.k; }; \
             o = { k: 10 }; a = f.bind(o, 5); b = a.bind({ k: 99 }, 2); t = b(3);",
            "t = b.call({ k: 99 }, 3); o.k = 20; t",
            "t = b.apply({ k: 99 }, { length: 1, 0: 4 }); t",
        ],
    );
    assert_eq!(last, "31");
}

#[test]
fn apply_array_like_paths_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "apply-array-like",
        &[
            "var o={k:20};var f=function(x,k,v){return x+k+v+this.k};var t;",
            "var o;var f;var t; \
             t=f.apply(o,{length:3,0:1,1:2,2:3})+':'+f.call(o,1,2,3)+':'+ \
             Math.max.apply(null,{length:3,0:2,1:9,2:4});t",
            "var t;t",
        ],
    );
    assert_eq!(last, "26:26:9");
}

#[test]
fn aggregate_error_iterables_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "aggregate-error-iterable",
        &[
            "var source={n:0,[Symbol.iterator]:function(){this.n=0;return this}, \
             next:function(){return this.n<2?{value:++this.n,done:false}:{done:true}}}; \
             var error;var values;",
            "var source;var error;var values; \
             error=new AggregateError(source,'boom');values=error.errors;error.message",
            "var error;var values;error.name+':'+error.message+':'+values.join(',')",
        ],
    );
    assert_eq!(last, "AggregateError:boom:1,2");
}

#[test]
fn observable_error_arguments_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "observable-error-arguments",
        &[
            "var message={toString:function(){return 'boom'}}; \
             var options={get cause(){return {code:17}}};var error;",
            "var message;var options;var error; \
             error=new TypeError(message,options);error.message+':'+error.cause.code",
            "var error;error.name+':'+error.message+':'+error.cause.code",
        ],
    );
    assert_eq!(last, "TypeError:boom:17");
}

#[test]
fn error_to_string_accessors_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "error-to-string-accessors",
        &[
            "var value={get name(){return '\\ud800'},get message(){return 'boom'}}; \
             var text;",
            "var value;var text;text=Error.prototype.toString.call(value);text.length",
            "var text;text.length+':'+text.charCodeAt(0)+':'+text.slice(3)",
        ],
    );
    assert_eq!(last, "7:55296:boom");
}

#[test]
fn exotic_object_spread_survives_sqlite_sleep_cycles() {
    let last = run_scenario(
        "exotic-object-spread",
        &[
            "var source=new Proxy(['a','b'],{get:function(t,k,r){return Reflect.get(t,k,r)}}); \
             var copy;",
            "var source;var copy;copy={...source};copy[0]+copy[1]",
            "var copy;Object.keys(copy).join('|')+':'+copy[0]+copy[1]",
        ],
    );
    assert_eq!(last, "0|1:ab");
}

#[test]
fn general_iterable_collection_constructors_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "general-iterable-collections",
        &[
            "var setSource={n:0,[Symbol.iterator]:function(){this.n=0;return this}, \
             next:function(){return this.n<3?{value:++this.n,done:false}:{done:true}}}; \
             var mapSource={n:0,[Symbol.iterator]:function(){this.n=0;return this}, \
             next:function(){this.n++;return this.n<=2? \
                 {value:[this.n,this.n*10],done:false}:{done:true}}};var s;var m;var t;",
            "var setSource;var mapSource;var s;var m;var t; \
             s=new Set(setSource);t=s.size+':'+s.has(2);t",
            "var setSource;var mapSource;var s;var m;var t; \
             m=new Map(mapSource);t=m.size+':'+m.get(2);t",
            "var setSource;var mapSource;var s;var m;var t; \
             t=s.has(3)+':'+m.get(1)+':'+m.get(2);t",
        ],
    );
    assert_eq!(last, "true:10:20");
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
fn iterator_prototype_accessors_survive_sqlite_sleep_cycles() {
    // Both pairs are omitted from ACCS and rebuilt from deterministic boot
    // structure, using the restored string- and symbol-key tables. Exercise
    // them after last-connection close/reopen boundaries.
    let last = carry_scenario(
        "carry-iterator-accessors",
        "Iterator.prototype; Object.create; Object.getOwnPropertyDescriptor; \
         Symbol.toStringTag; q.get; q.set; q.enumerable; q.configurable; \
         q.name; q.length; Object.prototype.toString.call; o.constructor; a.join;",
        &[
            "o = Object.create(Iterator.prototype); t = 7; t",
            "q = Object.getOwnPropertyDescriptor(Iterator.prototype, 'constructor'); \
             s = Object.getOwnPropertyDescriptor(Iterator.prototype, Symbol.toStringTag); \
             t = [q.get.name, q.get.length, q.set.name, q.set.length, \
                  q.enumerable, q.configurable, s.get.name, s.get.length, \
                  s.set.name, s.set.length, s.enumerable, s.configurable].join(':'); t",
            "o.constructor = 42; o[Symbol.toStringTag] = 'Saved'; \
             t = Object.prototype.toString.call(o) + ':' + o.constructor; t",
        ],
    );
    assert_eq!(last, "[object Saved]:42");
}

#[test]
fn iterator_terminal_helpers_survive_sqlite_sleep_cycles() {
    let last = carry_scenario(
        "carry-iterator-terminal-helpers",
        "Iterator.prototype.reduce; Iterator.prototype.find; \
         Object.create; i.next; j.next; j.return; j.n; closed; \
         i.length; i.values; j.value; j.done; k.next; k.toArray; k.join;",
        &[
            "i = [1, 2, 3, 4].values(); i.next(); \
             j = Object.create(Iterator.prototype); j.n = 0; closed = 0; \
             j.next = function () { return this.n < 3 ? \
                 { value: ++this.n } : { done: true }; }; \
             j.return = function () { closed++; return {}; }; \
             g = function* () { yield 3; yield 4; }; k = g(); k.next(); t = 7; t",
            "t = i.reduce(function (a, v) { return a + v; }, 10); t",
            "t = j.find(function (v, k) { return v === 2 && k === 1; }) + \
                 ':' + closed + ':' + k.toArray().join(','); t",
        ],
    );
    assert_eq!(last, "2:1:4");
}

#[test]
fn iterator_from_wrappers_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "iterator-from-wrapper",
        &[
            "base = { n: 0, next: function () { return this.n < 3 ? \
                 { value: ++this.n } : { done: true }; } }; \
             wrapped = Iterator.from(base); t = wrapped.next().value; t",
            "t = wrapped.toArray().join(','); t",
            "base.return = function () { return { value: 9, done: true }; }; \
             r = wrapped.return(); t = r.value + ':' + r.done; t",
        ],
    );
    assert_eq!(last, "9:true");
}

#[test]
fn regexp_string_iterators_survive_sqlite_sleep_cycles() {
    let last = carry_scenario(
        "carry-regexp-string-iterator",
        "''.matchAll; it.next; q.value; q.value.index; q.done;",
        &[
            "it = 'a1b22'.matchAll(/(\\d+)/g); it.next(); t = 7; t",
            "q = it.next(); \
             t = q.value[0] + ':' + q.value[1] + ':' + q.value.index + ':' + q.done; t",
            "q = it.next(); t = t + ':' + q.value + ':' + q.done; t",
        ],
    );
    assert_eq!(last, "22:22:3:false:undefined:true");
}

#[test]
fn regexp_match_and_search_protocols_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "regexp-match-search-protocols",
        &[
            "var rm=RegExp.prototype[Symbol.match]; \
             var rs=RegExp.prototype[Symbol.search]; var t=0; t",
            "var rm;var rs;var t;var n=0; \
             t=rm.call({flags:'g',lastIndex:4,exec:function(){n++;return n===1?{0:'x'}:null}},'x')[0]+':'+n;t",
            "var rm;var rs;var t;t=t+':'+rs.call(/b/,'abc');t",
        ],
    );
    assert_eq!(last, "x:2:1");
}

#[test]
fn regexp_split_protocol_survives_sqlite_sleep_cycles() {
    let last = run_scenario(
        "regexp-split-protocol",
        &[
            "var sp=RegExp.prototype[Symbol.split];var re=/(b)/;var t=0;t",
            "var sp;var re;var t;t=sp.call(re,'abc').join(':');t",
            "var sp;var re;var t;function C(){return {lastIndex:0,exec:function(){if(this.lastIndex===1){this.lastIndex=2;return {0:'y',1:'Z',length:2}}return null}}}var r={constructor:{[Symbol.species]:C},flags:''};t=t+'|'+sp.call(r,'xy').join(':');t",
        ],
    );
    assert_eq!(last, "a:b:c|x:Z:");
}

#[test]
fn array_of_results_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "array-of-results",
        &[
            "function C(n) { this.received = n; } \
             custom = Array.of.call(C, 1, 2); dense = Array.of(4, 5); \
             custom.received + ':' + dense.length",
            "custom[1] = custom[1] + dense[0]; \
             custom.received + ':' + custom[1] + ':' + dense[1]",
            "Object.getOwnPropertyDescriptor(Array.of, 'name').value + ':' + \
             custom.received + ':' + custom[1] + ':' + dense[1]",
        ],
    );
    assert_eq!(last, "of:2:6:5");
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
fn boxed_symbols_survive_sqlite_sleep_cycles() {
    let last = carry_scenario(
        "carry-symbol-wrapper",
        "Symbol.prototype[Symbol.toPrimitive]; Object(Symbol('s')); \
         w.valueOf; w.toString; Reflect.get; Object.getOwnPropertySymbols; length;",
        &[
            "sym = Symbol('s'); w = Object(sym); target = {}; t = 7;",
            "target[w] = 3; t = (w.valueOf() === sym) + ':' + w.toString(); t",
            "t = (Reflect.get(target, sym) === 3) + ':' + \
                 Object.getOwnPropertySymbols(target).length; t",
        ],
    );
    assert_eq!(last, "true:1");
}

#[test]
fn sloppy_this_wrappers_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "sloppy-this-wrappers",
        &[
            "var f=function(){return this};var s=f.call('abc');var q=Symbol('s');var y=f.call(q);var b=f.call(12n);var t=0;t",
            "var s;var q;var y;var b;var t;t=s[1]+':'+s.length+':'+(y.valueOf()===q)+':'+(b.valueOf()+1n);t",
        ],
    );
    assert_eq!(last, "b:3:true:13");
}

#[test]
fn array_buffer_slice_results_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "array-buffer-slice",
        &[
            "var b=new ArrayBuffer(5);var v=new Uint8Array(b);v.set([10,20,30,40,50]);var c;0",
            "c=b.slice(1,4);0",
            "v[2]=99;c.byteLength+':'+new Uint8Array(c).join(',')+':'+Object.prototype.toString.call(c)+':'+(ArrayBuffer[Symbol.species]===ArrayBuffer)",
        ],
    );
    assert_eq!(last, "3:20,30,40:[object ArrayBuffer]:true");
}

#[test]
fn array_buffer_transfer_survives_sqlite_sleep_cycles() {
    let last = run_scenario(
        "array-buffer-transfer",
        &[
            "var b=new ArrayBuffer(3);var v=new Uint8Array(b);v.set([11,22,33]);var c;0",
            "c=b.transferToFixedLength(5);0",
            "[b.detached,b.byteLength,v.byteLength,c.detached,c.maxByteLength,c.resizable,new Uint8Array(c).join(',')].join(':')",
        ],
    );
    assert_eq!(last, "true:0:0:false:5:false:11,22,33,0,0");
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
         Array.prototype.slice; a.slice; Array.prototype.splice; \
         Array.prototype.concat; a.concat; \
         Array.prototype.push; Array.prototype.pop; \
         Array.prototype.shift; Array.prototype.unshift; \
         Array.prototype.copyWithin; Array.prototype.fill; \
         Array.prototype.toString; Array.prototype.flat; \
         Array.prototype.flatMap; \
         Array.prototype.with; Array.prototype.toReversed; \
         Array.prototype.toSpliced; Array.prototype.with.name; \
         Array.prototype.sort.call; Uint8Array; Reflect.ownKeys; Reflect.set; \
         Object.prototype.hasOwnProperty; Symbol.isConcatSpreadable; \
         a.join; a.length; cw; fl; ts; ft; fm; 'con'; 'structor'; \
         (function (h, y, z) { return y; });",
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
             s = Array.prototype.splice.call(q, 1, 1, 8, 9); \
             f = {length: 4294967297}; f[4294967296] = 5; \
             b = {length: 0}; Array.prototype.push.call(b, 6, 7); \
             h = {0: 2, length: 1}; Array.prototype.unshift.call(h, 1); \
             cw = {0: 'a', 2: 'c', length: 3}; \
             fl = {length: 2}; \
             ts = [1, , 3]; \
             ft = {0: [1, , 2], length: 1}; \
             fm = {0: 3, length: 1}; \
             inst[Symbol.isConcatSpreadable] = true; z = [0].concat(inst); \
             delete inst[Symbol.isConcatSpreadable]; \
             t = inst.join(',') + ':' + Reflect.ownKeys(inst).join(',') + ':' + t; t",
            "t = inst.join(',') + ':' + Reflect.ownKeys(inst).join(',') + ':' + t + ':' + \
                 q[0] + ':' + Object.prototype.hasOwnProperty.call(q, 1) + ':' + q[2] + ':' + \
                 q.join('|') + ':' + s.length + ':' + \
                 Object.prototype.hasOwnProperty.call(s, 0) + ':' + \
                 Array.prototype.slice.name + ':' + Array.prototype.slice.length + ':' + \
                 g[0] + ':' + g.length + ':' + \
                 Array.prototype.concat.name + ':' + Array.prototype.concat.length + ':' + \
                 v.join(',') + ':' + Array.prototype.slice.call(f, 4294967296).join(',') + ':' + \
                 Object.prototype.hasOwnProperty.call(Array.prototype, k) + ':' + \
                 Array.prototype.pop.call(b) + ':' + b.length + ':' + b[0] + ':' + z.join(','); t",
            "Array.prototype.copyWithin.call(cw, 0, 1, 3); \
             Array.prototype.fill.call(fl, 'x'); \
             t = t + ':' + Array.prototype.shift.call(h) + ':' + h.length + ':' + h[0] + ':' + \
                 Object.prototype.hasOwnProperty.call(cw, 0) + ':' + cw[1] + ':' + cw[2] + ':' + \
                 fl[0] + ':' + fl[1] + ':' + Array.prototype.toString.call(ts) + ':' + \
                 Array.prototype.flat.call(ft).join(',') + ':' + \
                 Array.prototype.flatMap.call(fm, function (v) { return [v, v + 1]; }).join(','); t",
        ],
    );
    assert_eq!(
        last,
        "1,2:0,1:1,2:0,1:1,8,3:with:2:toReversed:0:toSpliced:2:1:true:9:1|8|9|3:1:false:slice:2:7:1:concat:1:1,2,3,4:5:false:7:1:6:0,1,2:1:1:2:false:c:c:x:x:1,,3:1,2:3,4"
    );
}

#[test]
fn implicit_array_stringification_survives_sqlite_sleep_cycles() {
    // Neither independently compiled crank names `toString` or `join`.
    // The second crank must still find Array's complete coercion path after a
    // full checkpoint, close, reopen, restore, and partial relink.
    let last = run_scenario(
        "implicit-array-stringification",
        &["var seed=1;", "var seed;''+[seed,seed+1]"],
    );
    assert_eq!(last, "1,2");
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

#[test]
fn a_custom_capability_executor_survives_sqlite_sleep_cycles() {
    let last = run_scenario(
        "promise-capability-executor",
        &[
            "var ex = 0; var log = ''; \
             function C(e) { ex = e; e(function (v) { log = 'r' + v; }, \
                                        function (v) { log = 'j' + v; }); return {}; } \
             Promise.resolve.call(C, 5); log",
            "typeof ex + ':' + ex.name + ':' + ex.length + ':' + log",
            "try { ex(function () {}, function () {}); false } \
             catch (e) { e instanceof TypeError }",
        ],
    );
    assert_eq!(last, "true");
}

#[test]
fn a_custom_species_reaction_survives_sqlite_sleep_cycles() {
    let last = run_scenario(
        "promise-custom-species-reaction",
        &[
            "var p=0;var res=0;var q=0;var result={tag:9};var log=''; \
             function C(executor){executor(function(v){log='r'+v}, \
                                                   function(e){log='j'+e});return result} \
             p=new Promise(function(resolve){res=resolve});p.constructor={}; \
             p.constructor[Symbol.species]=C;q=p.then(function(v){return v+1});q===result",
            "(q===result)+':'+q.tag+':'+log",
            "res(41);0",
            "log",
        ],
    );
    assert_eq!(last, "r42");
}

#[test]
fn promise_intrinsic_metadata_survives_sqlite_sleep_cycles() {
    let last = run_scenario(
        "promise-intrinsic-metadata",
        &[
            "var p=Promise.resolve(1);p.then(function(){});0",
            "Promise.all([]);0",
            "var s=Object.getOwnPropertyDescriptor(Promise,Symbol.species); \
             var t=Object.getOwnPropertyDescriptor(Promise.prototype,Symbol.toStringTag); \
             [Promise.all.name,Promise.all.length,Promise.prototype.then.name, \
              Promise.prototype.then.length,s.get.name,s.get.length, \
              s.get.call(Promise)===Promise,t.value,t.writable,t.enumerable, \
              t.configurable].join(':')",
        ],
    );
    assert_eq!(
        last,
        "all:1:then:2:get [Symbol.species]:0:true:Promise:false:false:true"
    );
}

#[test]
fn poisoned_then_lookup_rejection_survives_sqlite_sleep_cycles() {
    let last = run_scenario(
        "promise-poisoned-then-lookup",
        &[
            "var marker={};var x={};var p=0;var g=''; \
             Object.defineProperty(x,'then',{get:function(){throw marker}}); \
             p=Promise.resolve(x);0",
            "p.then(function(){g='fulfilled'},function(e){g=''+(e===marker)});0",
            "g",
        ],
    );
    assert_eq!(last, "true");
}

#[test]
fn escaped_finally_wrapper_survives_sqlite_sleep_cycles() {
    let last = run_scenario(
        "promise-finally-custom-then-wrapper",
        &[
            "var saved=0;var g='';var result={};var o={constructor:Promise,then:function(a,b){saved=a;return result}}; \
             Promise.prototype.finally.call(o,function(){g+='h';return 1})===result",
            "saved(8).then(function(v){g+=':'+v});0",
            "g",
        ],
    );
    assert_eq!(last, "h:8");
}

#[test]
fn escaped_finally_value_thunks_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "promise-finally-custom-value-thunks",
        &[
            "var savedF=0;var savedR=0;var marker={};var phase=0;var result={};function C(exec){exec(function(){},function(){});return {then:function(f){if(phase++===0){savedF=f}else{savedR=f}return result}}}Object.defineProperty(C,Symbol.species,{value:C});var of={constructor:C,then:function(a){return a(8)}};var or={constructor:C,then:function(a,b){return b(marker)}};Promise.prototype.finally.call(of,function(){return 1})===result&&Promise.prototype.finally.call(or,function(){return 2})===result",
            "var savedF;var savedR;var marker;typeof savedF+':'+savedF.name+':'+savedF.length+':'+typeof savedR+':'+savedR.name+':'+savedR.length",
            "var savedF;var savedR;var marker;var caught=false;var value=savedF();try{savedR()}catch(e){caught=e===marker}value+':'+caught",
        ],
    );
    assert_eq!(last, "8:true");
}

#[test]
fn a_custom_species_finally_await_survives_sqlite_sleep_cycles() {
    let last = run_scenario(
        "promise-custom-species-finally",
        &[
            "var P=class extends Promise{};var gate=0;var release=0;var q=0;var g=''; \
             gate=new Promise(function(resolve){release=resolve});var p=Promise.resolve(5); \
             p.constructor={};p.constructor[Symbol.species]=P; \
             q=p.finally(function(){return gate});q instanceof P",
            "(q instanceof P)+':'+(q.constructor===P)+':'+g",
            "q.then(function(v){g='r'+v},function(e){g='j'+e});release(1);0",
            "g",
        ],
    );
    assert_eq!(last, "r5");
}

#[test]
fn a_custom_capability_combinator_survives_sqlite_sleep_cycles() {
    let last = run_scenario(
        "promise-custom-combinator",
        &[
            "var p=0;var res=0;var q=0;var result={tag:9};var log=''; \
             function C(executor){executor(function(v){log='r'+v[0]}, \
                                           function(e){log='j'+e});return result} \
             C.resolve=function(v){return Promise.resolve(v)}; \
             p=new Promise(function(resolve){res=resolve}); \
             q=Promise.all.call(C,[p]);q===result",
            "(q===result)+':'+q.tag+':'+log",
            "res(42);0",
            "log",
        ],
    );
    assert_eq!(last, "r42");
}

#[test]
fn a_retained_custom_then_element_callback_survives_sqlite_sleep_cycles() {
    let last = run_scenario(
        "promise-direct-combinator",
        &[
            "var fulfill=0;var result={};var log=''; \
             function C(executor){executor(function(v){log='r'+v[0]}, \
                                           function(e){log='j'+e});return result} \
             C.resolve=function(){return {then:function(resolve){fulfill=resolve}}}; \
             Promise.all.call(C,[1]);typeof fulfill",
            "typeof fulfill+':'+fulfill.name+':'+fulfill.length+':'+log",
            "fulfill(42);fulfill(9);0",
            "log",
        ],
    );
    assert_eq!(last, "r42");
}

#[test]
fn a_pending_finally_result_survives_sqlite_sleep_cycles() {
    // `onFinally` runs in crank 1 but its returned promise remains pending.
    // The `FinallyAwait` row, original fulfillment, and derived capability all
    // cross a complete SQLite close/reopen before crank 2 releases the gate.
    let last = run_scenario(
        "promise-finally-await",
        &[
            "var release = 0; var g = 0; var gate = new Promise(function (rs) { release = rs; }); \
             Promise.resolve(5).finally(function () { return gate; }) \
              .then(function (v) { g = 'v:' + v; }, function (e) { g = 'e:' + e; });",
            "release(9); 0",
            "g",
        ],
    );
    assert_eq!(last, "v:5");
}
