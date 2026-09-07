//! An indexed READ creates nothing, so it must not mint a property key.
//!
//! `GET_PROPERTY_AT` interned `index.to_string()` on every branch that did
//! not resolve the index out of a side table, and `intern_key` mints a fresh
//! `u16` (and meters a slot allocation) per novel name. A guest loop over
//! distinct indices therefore carried the name table into the meet with the
//! symbol-key floor — the saturation guard pinned by
//! `id_space_exhaustion.rs`, which POISONS the machine rather than throwing
//! something the guest can catch. `for (var i = 0; i < 70000; i++) o[i]`, an
//! ordinary loop over an ordinary object, was a denial of service on the
//! whole engine.
//!
//! XS mints nothing here either: `XS_CODE_GET_PROPERTY_AT` passes
//! `(XS_NO_ID, index)` straight to `mxBehaviorGetProperty`, and a Proxy trap's
//! key is built from the index by `fxKeyAt` without touching the key table.
//! So the read looks its name up instead, and answers `undefined` when the
//! table has never held it — after checking the receivers that resolve an
//! index WITHOUT a name (array items, String-wrapper units, TypedArray
//! elements, a Proxy's `get` trap), which still answer exactly as before.

use ironhorse_vm::{run_program_with_symbols, RunOutcome};

fn run(source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    run_program_with_symbols(&bytecode, &symbols)
}

fn assert_result(source: &str, expected: &str) {
    let out = run(source);
    assert!(
        out.completed,
        "must complete; halt: {:?}\n  {source}",
        out.halt
    );
    assert_eq!(out.result, expected, "{source}");
}

/// 70,000 distinct indices is past the `u16` id space: before the fix each
/// of these loops halted with `Unsupported("property-key:id-space-exhausted")`.
const NOVEL_INDICES: u32 = 70_000;

#[test]
fn an_index_read_on_an_ordinary_object_mints_no_key() {
    assert_result(
        &format!("var o = {{}}; var n = 0; for (var i = 0; i < {NOVEL_INDICES}; i++) {{ if (o[i] !== undefined) n++; }} n"),
        "0",
    );
}

#[test]
fn an_index_read_on_a_sparse_array_mints_no_key() {
    assert_result(
        &format!("var a = []; var n = 0; for (var i = 0; i < {NOVEL_INDICES}; i++) {{ if (a[i] !== undefined) n++; }} n"),
        "0",
    );
}

#[test]
fn an_index_read_through_an_untrapped_proxy_mints_no_key() {
    assert_result(
        &format!("var p = new Proxy({{}}, {{}}); var n = 0; for (var i = 0; i < {NOVEL_INDICES}; i++) {{ if (p[i] !== undefined) n++; }} n"),
        "0",
    );
}

/// A `get` trap is still CALLED for an index the key table has no name for —
/// the key it is handed is built from the index, not minted — and an ordinary
/// target needs no id for the post-trap invariant check either, so a trapping
/// proxy over novel indices also stays inside the id space.
#[test]
fn an_index_read_through_a_get_trap_mints_no_key() {
    assert_result(
        &format!(
            "var p = new Proxy({{}}, {{ get: function (t, k) {{ return k; }} }}); \
             var last = ''; \
             for (var i = 0; i < {NOVEL_INDICES}; i++) {{ last = p[i]; }} last"
        ),
        &format!("{}", NOVEL_INDICES - 1),
    );
}

#[test]
fn an_existing_indexed_property_still_resolves() {
    // Ordinary object: the write interns the name, so the read finds it.
    assert_result("var o = {}; o[0] = 7; o[0]", "7");
    assert_result("var o = {}; o[0] = 7; var i = 0; o[i]", "7");
    // Array item: resolved out of the item chunk, with no name at all.
    assert_result("var a = [4, 5, 6]; a[1]", "5");
    assert_result("var a = []; a[9] = 'x'; a[9]", "x");
    // String primitive and String wrapper units.
    assert_result("'abc'[1]", "b");
    assert_result("var s = new String('abc'); s[2]", "c");
}

/// The uninterned-name fast path must not shortcut a receiver whose index
/// properties live in a side table rather than under a name — reached
/// directly, or inherited, or forwarded to by an untrapped proxy.
#[test]
fn an_index_read_still_reaches_the_exotics_that_answer_without_a_name() {
    assert_result("var p = new Proxy([9, 8], {}); p[1]", "8");
    assert_result("var p = new Proxy(new String('hi'), {}); p[0]", "h");
    assert_result("var o = Object.create([1, 2, 3]); o[2]", "3");
    assert_result(
        "var o = Object.create(new Proxy({}, { get: function (t, k) { return k; } })); o[5]",
        "5",
    );
    assert_result("var t = new Uint8Array(3); t[1] = 42; t[1]", "42");
    assert_result("var p = new Proxy(new Uint8Array(2), {}); p[0]", "0");
}

/// A trapping proxy still answers with the trap's value, and the trap still
/// sees the canonical numeric string for the index.
#[test]
fn a_get_trap_still_sees_the_canonical_numeric_key() {
    assert_result(
        "var p = new Proxy({}, { get: function (t, k) { return typeof k + ':' + k; } }); p[3]",
        "string:3",
    );
    assert_result(
        "var a = [1, 2]; var p = new Proxy(a, { get: function (t, k) { return 'trap' + k; } }); p[1]",
        "trap1",
    );
}
