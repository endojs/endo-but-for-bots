//! Stage-7 child 2/7 behavioral gate: symbol-keyed property operations
//! (design [`designs/ironhorse-engine.md`] § the engine boot-surface
//! residuals — the SES shim brands objects with symbol keys).
//!
//! A symbol value used as a property key (`o[sym]`, `Object.defineProperty(o,
//! sym, …)`, the `Reflect.*` surface, `sym in o`) resolves its
//! descriptor-slot identity to a stable interned key id (XS's `mxID(symbol)`),
//! so the same symbol round-trips and two distinct symbols are distinct keys.
//! Symbol keys are partitioned OUT of `Object.keys` (the string-key
//! enumeration). Each snippet is dual-run against the XS oracle; the gate is
//! **result agreement where the oracle accepts the program** (`BothComplete` +
//! `result_agrees`), per the accuracy-over-parity doctrine.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str) {
    let dr = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        dr.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?}; oracle={:?} ironhorse={:?})",
        dr.ironhorse_halt,
        dr.oracle_result,
        dr.ironhorse_result,
    );
    assert!(
        dr.result_agrees,
        "`{source}` result divergence: oracle={:?} ironhorse={:?}",
        dr.oracle_result, dr.ironhorse_result,
    );
}

// -------------------------------------------------------------------------
// §1  Computed symbol-key assignment / read round-trips.
// -------------------------------------------------------------------------

#[test]
fn symbol_key_assignment_round_trips() {
    assert_result_agrees("var s = Symbol(); var o = {}; o[s] = 42; o[s]");
    assert_result_agrees("var s = Symbol('desc'); var o = {}; o[s] = 'v'; o[s]");
    // The same symbol resolves the same slot across writes.
    assert_result_agrees("var s = Symbol(); var o = {}; o[s] = 1; o[s] = 2; o[s]");
    // A missing symbol key reads `undefined`.
    assert_result_agrees("var s = Symbol(); var o = {}; o[s]");
}

#[test]
fn distinct_symbols_are_distinct_keys() {
    assert_result_agrees(
        "var a = Symbol(); var b = Symbol(); var o = {}; o[a] = 1; o[b] = 2; o[a]",
    );
    assert_result_agrees(
        "var a = Symbol(); var b = Symbol(); var o = {}; o[a] = 1; o[b] = 2; o[b]",
    );
    // A well-known symbol is a distinct key from a fresh user symbol.
    assert_result_agrees(
        "var s = Symbol(); var o = {}; o[s] = 1; o[Symbol.iterator] = 2; o[s]",
    );
}

// -------------------------------------------------------------------------
// §2  `Symbol()`-keyed `Object.defineProperty` / `getOwnPropertyDescriptor`.
// -------------------------------------------------------------------------

#[test]
fn object_define_property_symbol_key() {
    assert_result_agrees(
        "var s = Symbol(); var o = {}; \
         Object.defineProperty(o, s, { value: 7, writable: true, enumerable: true, configurable: true }); \
         o[s]",
    );
    assert_result_agrees(
        "var s = Symbol(); var o = {}; \
         Object.defineProperty(o, s, { value: 7, writable: true, enumerable: false, configurable: true }); \
         Object.getOwnPropertyDescriptor(o, s).value",
    );
    assert_result_agrees(
        "var s = Symbol(); var o = {}; \
         Object.defineProperty(o, s, { value: 7, writable: false, enumerable: false, configurable: true }); \
         Object.getOwnPropertyDescriptor(o, s).writable",
    );
    // An absent symbol key's descriptor is `undefined`.
    assert_result_agrees("var s = Symbol(); Object.getOwnPropertyDescriptor({}, s)");
}

// -------------------------------------------------------------------------
// §3  The `Reflect.*` surface with symbol keys.
// -------------------------------------------------------------------------

#[test]
fn reflect_symbol_key() {
    assert_result_agrees(
        "var s = Symbol(); var o = {}; \
         Reflect.defineProperty(o, s, { value: 9, writable: true, enumerable: true, configurable: true }); \
         Reflect.get(o, s)",
    );
    assert_result_agrees("var s = Symbol(); var o = {}; o[s] = 1; Reflect.has(o, s)");
    assert_result_agrees("var s = Symbol(); var o = {}; Reflect.has(o, s)");
    assert_result_agrees("var s = Symbol(); var o = {}; Reflect.set(o, s, 5); Reflect.get(o, s)");
    assert_result_agrees(
        "var s = Symbol(); var o = {}; o[s] = 1; Reflect.deleteProperty(o, s); Reflect.has(o, s)",
    );
}

// -------------------------------------------------------------------------
// §4  `in`, `delete`, and the string/symbol key partition.
// -------------------------------------------------------------------------

#[test]
fn symbol_in_and_delete() {
    assert_result_agrees("var s = Symbol(); var o = {}; o[s] = 1; s in o");
    assert_result_agrees("var s = Symbol(); var o = {}; s in o");
    // `delete o[s]` via `Reflect.deleteProperty` (the computed-key `delete`
    // opcode `DELETE_PROPERTY_AT` is unmodeled for ANY key — a pre-existing gap
    // unrelated to symbols — so the symbol-key delete is exercised through the
    // `Reflect` surface in `reflect_symbol_key` above, not `delete o[s]`).
    assert_result_agrees(
        "var s = Symbol(); var o = {}; o[s] = 1; Reflect.deleteProperty(o, s); s in o",
    );
}

#[test]
fn object_keys_excludes_symbol_keys() {
    // A symbol key does not appear in `Object.keys` (string-key enumeration),
    // so a string-keyed object with an extra symbol key keeps its string count.
    assert_result_agrees("var s = Symbol(); var o = { a: 1, b: 2 }; o[s] = 3; Object.keys(o).length");
    assert_result_agrees("var s = Symbol(); var o = {}; o[s] = 3; Object.keys(o).length");
    assert_result_agrees("var s = Symbol(); var o = { a: 1 }; o[s] = 3; Object.keys(o)[0]");
}

#[test]
fn get_own_property_descriptor_on_a_symbol_receiver_is_undefined() {
    // `Object.getOwnPropertyDescriptor(sym, k)` ToObject-wraps the symbol in a
    // Symbol exotic with NO own properties, so `[[GetOwnProperty]]` is
    // `undefined` for every key. A `Symbol` is `Kind::Symbol` +
    // `Payload::Reference(descriptor)`, so an unguarded `Payload::Reference`
    // arm would instead narrow the symbol to its internal descriptor slot and
    // probe THAT — a latent divergence this locks against. (`String(...)`
    // renders the `undefined` result so the dual-run compares a primitive.)
    assert_result_agrees("String(Object.getOwnPropertyDescriptor(Symbol('a'), 'x'))");
    assert_result_agrees("var s=Symbol('a'); typeof Object.getOwnPropertyDescriptor(s, 'description')");
    assert_result_agrees("Object.getOwnPropertyDescriptor(Symbol.iterator, 'toString') === undefined");
}
