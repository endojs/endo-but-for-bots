//! Wave-6 W6-9 gate graduation locks.
//!
//! The blast-radius probe showed a resumed heap holding a Proxy or an
//! accessor property answered wrong values. Function, proxy, accessor,
//! and Intl bound-function state now travel. Error data and
//! the typed-array family started here and GRADUATED: they travel in
//! the `ERRD` (store schema 9) and `ABUF`/`TARR`/`DVIW` (schema 10)
//! atoms (`error_data_carry.rs` / `typed_array_carry.rs` hold their
//! twins).

use ironhorse_snapshot::machine::begin_store_session;
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::Interp;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn machine_running(src: &str) -> Interp {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    let n = ironhorse_vm::parse_symbols(&s);
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let o = m.run(&b);
    assert!(o.completed, "fixture crank: {:?}", o.halt);
    m
}

#[test]
fn a_heap_holding_a_live_proxy_persists() {
    let mut store = MemoryStore::new();
    begin_store_session(
        machine_running("var p = 0; p = new Proxy({ v: 1 }, {}); 0;"),
        &sig(),
        &mut store,
    )
    .map_err(|(_, error)| error)
    .expect("proxy state travels");
}

#[test]
fn a_heap_holding_a_guest_accessor_persists() {
    let mut store = MemoryStore::new();
    begin_store_session(
        machine_running(
            "var o = 0; o = {}; \
             Object.defineProperty(o, 'x', { get: function () { return 1; } }); 0;",
        ),
        &sig(),
        &mut store,
    )
    .map_err(|(_, error)| error)
    .expect("guest accessors travel");
}

/// The boot-seed exemption (the Intl carry, store schema 12) admits
/// EXACTLY the seeded `proto_accessors` entry — the `Intl.NumberFormat`
/// `format` getter, whose side-table pair `restore_snapshot_state`
/// re-derives from boot structure. A guest REDEFINITION at the very
/// same key stores a different getter. The ACCS carry now preserves
/// that redefinition instead of confusing it with the boot seed.
#[test]
fn a_redefined_seed_accessor_persists() {
    let mut store = MemoryStore::new();
    begin_store_session(
        machine_running(
            "var t = 0; \
             Object.defineProperty(Intl.NumberFormat.prototype, 'format', \
               { get: function () { return 1; }, configurable: true }); \
             t = 7; 0;",
        ),
        &sig(),
        &mut store,
    )
    .map_err(|(_, error)| error)
    .expect("guest seed redefinitions travel");
}

#[test]
fn an_accessor_holding_an_intl_bound_function_persists() {
    let mut store = MemoryStore::new();
    begin_store_session(
        machine_running(
            "var nf = 0; var o = 0; var format = 0; \
             nf = new Intl.NumberFormat('en'); format = nf.format; o = {}; \
             Object.defineProperty(o, 'x', { get: format }); 0;",
        ),
        &sig(),
        &mut store,
    )
    .map_err(|(_, error)| error)
    .expect("Intl bound functions travel before accessors restore");
}

/// And the exemption's positive half: a heap whose only accessor row IS
/// the boot seed (any Intl-referencing program) persists. Before the
/// exemption every Intl-touching heap refused, which masked the Intl
/// record rows entirely.
#[test]
fn a_heap_holding_only_the_boot_seed_accessor_persists() {
    let mut store = MemoryStore::new();
    begin_store_session(machine_running("var t = 0; t = typeof Intl; 0;"), &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("the boot-seeded accessor is re-derived at restore, not lost");
}

/// A COLLECTED instance is no longer a hazard — the witness asks what
/// the heap holds, not what it ever held (the mint-counter lesson).
#[test]
fn a_collected_proxy_persists_again() {
    let mut m = machine_running("(function () { var p = new Proxy({}, {}); })(); 0;");
    m.collect_garbage();
    let mut store = MemoryStore::new();
    begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("a collected proxy is no longer held");
}

/// The negative control: an ordinary heap still persists.
#[test]
fn an_ordinary_heap_still_persists() {
    let mut store = MemoryStore::new();
    begin_store_session(
        machine_running("var x = 0; x = { a: 1 }; 0;"),
        &sig(),
        &mut store,
    )
    .map_err(|(_, e)| e)
    .expect("plain heaps are unaffected");
}
