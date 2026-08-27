//! Wave-6 W6-9: the four SILENT-WRONG Pending rows refuse to persist.
//!
//! The blast-radius probe showed a resumed heap holding a Proxy,
//! an accessor property, a TypedArray, or Error data answers WRONG
//! VALUES (a plain-object degradation the consuming natives never
//! notice), where the other Pending rows fail visibly via per-native
//! `this` guards. Until their atoms land (the recorded G3 lift), the
//! persist verbs refuse such heaps by name — the `Segments` precedent:
//! honest refusal over silent corruption.

use ironhorse_snapshot::machine::begin_store_session;
use ironhorse_snapshot::store::{MemoryStore, StoreError};
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

fn refuses(src: &str, row: &'static str) {
    let mut store = MemoryStore::new();
    match begin_store_session(machine_running(src), &sig(), &mut store) {
        Err((_, StoreError::PendingStateUnsupported { row: r })) => {
            assert_eq!(r, row, "the refusal names the row held");
        }
        Err((_, e)) => panic!("expected PendingStateUnsupported({row}), got {e:?}"),
        Ok(_) => panic!("a heap holding live {row} must refuse to persist"),
    }
}

#[test]
fn a_heap_holding_a_live_proxy_refuses_to_persist() {
    refuses("var p = 0; p = new Proxy({ v: 1 }, {}); 0;", "proxies");
}

#[test]
fn a_heap_holding_a_guest_accessor_refuses_to_persist() {
    refuses(
        "var o = 0; o = {}; \
         Object.defineProperty(o, 'x', { get: function () { return 1; } }); 0;",
        "accessors",
    );
}

#[test]
fn a_heap_holding_a_typed_array_refuses_to_persist() {
    refuses("var t = 0; t = new Uint8Array(8); 0;", "typed arrays");
}

#[test]
fn a_heap_holding_a_live_error_refuses_to_persist() {
    refuses("var e = 0; e = new Error('kept'); 0;", "error data");
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
