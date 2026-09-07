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

/// The post-trap `[[Get]]` invariant check (ECMA-262 10.5.8 step 10) still
/// runs for an index the key table has no id for.
///
/// This is the one arm where the read still mints a key: the check has to
/// name the index back to the target, and a target whose own index properties
/// live in a SIDE TABLE — a String wrapper's units here — has to be asked. An
/// ordinary target is skipped instead (it cannot carry an own property under a
/// name that was never interned), which is what keeps a trapping proxy over
/// novel indices inside the id space.
#[test]
fn a_get_trap_cannot_contradict_a_non_configurable_index_it_was_never_named_for() {
    // A String wrapper's units are non-configurable and non-writable without
    // any define naming them, so the key table has no id for "0" when the
    // trap runs — and the trap's lie must still be rejected.
    assert_result(
        "var p = new Proxy(new String('hi'), { get: function () { return 'z'; } }); \
         var r = 'no-throw'; try { r = p[0]; } catch (e) { r = (e instanceof TypeError) ? 'TypeError' : 'other'; } r",
        "TypeError",
    );
    // The honest answer passes the same check.
    assert_result(
        "var p = new Proxy(new String('hi'), { get: function () { return 'h'; } }); p[0]",
        "h",
    );
    // A TypedArray element is writable and configurable, so a differing trap
    // result is permitted rather than rejected.
    assert_result(
        "var p = new Proxy(new Uint8Array(2), { get: function () { return 5; } }); p[0]",
        "5",
    );
    // A frozen array behind an untrapped proxy still forwards to the item.
    assert_result("var a = [7]; Object.freeze(a); var p = new Proxy(a, {}); p[0]", "7");
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

/// A numeric key and its string spelling are the SAME key: `ToPropertyKey`
/// runs first. Reading the canonical index off the raw argument saw only the
/// string form, so `gopd(view, 1)` took the ordinary path — answering
/// `undefined` where `gopd(view, "1")` answered the element descriptor, and
/// interning a name on the way. Both spellings now answer the element.
#[test]
fn a_numeric_key_reads_the_same_typed_array_element_as_its_string_spelling() {
    for key in ["1", "'1'"] {
        assert_result(
            &format!(
                "var d = Object.getOwnPropertyDescriptor(new Uint8Array(4), {key}); \
                 d.value + ',' + d.writable + ',' + d.enumerable + ',' + d.configurable"
            ),
            "0,true,true,true",
        );
    }
    // An index past the end is absent under either spelling.
    assert_result(
        "Object.getOwnPropertyDescriptor(new Uint8Array(4), 9) === undefined",
        "true",
    );
}

/// The index-keyed read paths still reach every observable behaviour that
/// needs the key: a Proxy trap fires with the canonical numeric string, an
/// untrapped Proxy forwards to its target's exotic index, and the chain walk
/// still finds an inherited exotic.
#[test]
fn the_other_index_keyed_operations_still_answer_correctly() {
    // `in` — own, inherited, absent, and through a proxy trap.
    assert_result("var a = [1, 2]; 1 in a", "true");
    assert_result("var a = [1, 2]; 5 in a", "false");
    assert_result("var o = Object.create([1, 2, 3]); 2 in o", "true");
    assert_result("0 in new Proxy([7], {})", "true");
    assert_result(
        "var p = new Proxy({}, { has: function (t, k) { return k === '3'; } }); 3 in p",
        "true",
    );
    assert_result("0 in new String('hi')", "true");
    assert_result("var t = new Uint8Array(2); 1 in t", "true");
    assert_result("var t = new Uint8Array(2); 9 in t", "false");
    // `delete` — an array item goes, a frozen one refuses, an absent one is
    // a vacuous true, and a String-wrapper unit is non-configurable.
    assert_result("var a = [1, 2]; delete a[0]; a[0] === undefined", "true");
    assert_result("var a = [1]; Object.freeze(a); delete a[0]", "false");
    assert_result("var o = {}; delete o[7]", "true");
    assert_result("var s = new String('hi'); delete s[0]", "false");
    assert_result(
        "var seen = ''; var p = new Proxy({}, { deleteProperty: function (t, k) { seen = k; return true; } }); delete p[4]; seen",
        "4",
    );
    // `hasOwnProperty` — own index, inherited index (false), string units.
    assert_result("var a = [1, 2]; a.hasOwnProperty(1)", "true");
    assert_result("var o = Object.create([1, 2]); o.hasOwnProperty(1)", "false");
    assert_result("'abc'.hasOwnProperty(2)", "true");
    assert_result("'abc'.hasOwnProperty(3)", "false");
    // `Reflect.*` on an index.
    assert_result("Reflect.get([4, 5], 1)", "5");
    assert_result("Reflect.has([4, 5], 1)", "true");
    assert_result("var a = [4, 5]; Reflect.deleteProperty(a, 0); a[0] === undefined", "true");
    assert_result(
        "var d = Reflect.getOwnPropertyDescriptor([4], 0); d.value + ',' + d.enumerable",
        "4,true",
    );
    // `super[i]` reaches the home object's prototype.
    assert_result(
        "class B {} B.prototype[3] = 'x'; \
         class C extends B { m() { return super[3]; } } (new C()).m()",
        "x",
    );
}

/// A boxed primitive reads an inherited index that no name ever keyed. The
/// arm answered `undefined` outright; the wrapper prototype's own chain can
/// still answer an index without a name.
#[test]
fn a_boxed_primitive_reads_an_inherited_index_off_its_wrapper_prototype() {
    assert_result(
        "Object.setPrototypeOf(Number.prototype, [1, 2, 3]); (5)[0]",
        "1",
    );
    assert_result(
        "Object.setPrototypeOf(Number.prototype, new Proxy({}, { get: function (t, k) { return 'trap' + k; } })); (5)[7]",
        "trap7",
    );
    // A named read off the wrapper prototype is unaffected.
    assert_result("(5).toString()", "5");
}
