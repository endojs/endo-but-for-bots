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
    assert_result(
        "var a = [7]; Object.freeze(a); var p = new Proxy(a, {}); p[0]",
        "7",
    );
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
    assert_result(
        "var o = Object.create([1, 2]); o.hasOwnProperty(1)",
        "false",
    );
    assert_result("'abc'.hasOwnProperty(2)", "true");
    assert_result("'abc'.hasOwnProperty(3)", "false");
    // `Reflect.*` on an index.
    assert_result("Reflect.get([4, 5], 1)", "5");
    assert_result("Reflect.has([4, 5], 1)", "true");
    assert_result(
        "var a = [4, 5]; Reflect.deleteProperty(a, 0); a[0] === undefined",
        "true",
    );
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

/// Every Proxy trap is looked up EXACTLY ONCE per operation, whichever
/// spelling the key arrives in.
///
/// The index arms resolve the trap themselves so that an untrapped proxy can
/// forward without building a key. Delegating the trapped case back to the
/// id-keyed entry point re-ran `proxy_trap`, so a handler whose trap is an
/// accessor ran its getter twice and the lookup metered twice —
/// `getOwnPropertyDescriptor` and `deleteProperty` both did, while the named
/// spelling of the very same operation looked up once.
#[test]
fn a_proxy_trap_is_looked_up_once_per_operation_for_either_key_spelling() {
    // The handler is a Proxy over a real handler that DOES define the traps,
    // so each look-up is both observable and successful.
    let counter = "\
        var looks = []; \
        var real = { \
          getOwnPropertyDescriptor: function (t, k) { return undefined; }, \
          deleteProperty: function (t, k) { return true; }, \
          has: function (t, k) { return false; } \
        }; \
        var handler = new Proxy(real, { get: function (t, k) { looks.push(k); return t[k]; } }); \
        var p = new Proxy({}, handler); ";
    for (expr, trap) in [
        (
            "Object.getOwnPropertyDescriptor(p, 'x')",
            "getOwnPropertyDescriptor",
        ),
        (
            "Object.getOwnPropertyDescriptor(p, 0)",
            "getOwnPropertyDescriptor",
        ),
        (
            "Reflect.getOwnPropertyDescriptor(p, 0)",
            "getOwnPropertyDescriptor",
        ),
        ("delete p.x", "deleteProperty"),
        ("delete p[0]", "deleteProperty"),
        ("Reflect.deleteProperty(p, 0)", "deleteProperty"),
        ("'x' in p", "has"),
        ("0 in p", "has"),
        ("Reflect.has(p, 0)", "has"),
    ] {
        assert_result(&format!("{counter} {expr}; looks.join(',')"), trap);
    }
}

/// The index walk and the id path must agree on the ANSWER for every
/// receiver shape.
///
/// Which one runs is decided by whether the index's canonical name happens to
/// be interned — an unrelated `z[0] = 1` elsewhere in the program flips it —
/// so the two must be indistinguishable to the guest. They are not
/// indistinguishable in COST: ironhorse stores an ordinary object's index
/// property as a named slot, so the id path scans the name chain while the
/// index walk consults the side tables, and the two differ by a computron or
/// two. XS has no such split (`fxOrdinarySetProperty` with `id == 0` grows an
/// internal array slot, and `fxOrdinaryGetProperty` with `id == 0` reads it
/// back, interning nothing either way), which is why the index walk is the
/// closer of the two to the oracle.
#[test]
fn the_index_walk_and_the_id_path_agree_on_every_receiver_shape() {
    // `z[0] = 1` interns "0" without touching the receiver under test, so the
    // same source runs down the id path in the second machine.
    for prelude in ["", "var z = {}; z[0] = 1;"] {
        let at = |body: &str| format!("{prelude} {body}");
        assert_result(
            &at("var o = Object.create(Object.create({})); String(o[0])"),
            "undefined",
        );
        assert_result(
            &at("var o = Object.create(Object.create({})); String(0 in o)"),
            "false",
        );
        assert_result(&at("var o = Object.create(null); String(0 in o)"), "false");
        assert_result(&at("var o = {}; String(delete o[0])"), "true");
        assert_result(&at("var o = {}; String(o.hasOwnProperty(0))"), "false");
        assert_result(
            &at("var o = {}; String(Object.getOwnPropertyDescriptor(o, 0) === undefined)"),
            "true",
        );
        assert_result(&at("var o = {}; String(Reflect.get(o, 0))"), "undefined");
        assert_result(&at("var o = {}; String(Reflect.has(o, 0))"), "false");
        assert_result(&at("var a = [7]; String(a[0])"), "7");
        assert_result(&at("var a = [7]; String(0 in a)"), "true");
        assert_result(&at("var a = [7]; String(a.hasOwnProperty(0))"), "true");
        assert_result(&at("var p = new Proxy({}, {}); String(p[0])"), "undefined");
        assert_result(&at("var p = new Proxy({}, {}); String(0 in p)"), "false");
        assert_result(&at("var p = new Proxy([7], {}); String(p[0])"), "7");
        assert_result(&at("var t = new Uint8Array(2); String(t[0])"), "0");
        assert_result(&at("var t = new Uint8Array(2); String(0 in t)"), "true");
        assert_result(&at("var t = new Uint8Array(2); String(9 in t)"), "false");
        assert_result(&at("var s = new String('hi'); String(s[0])"), "h");
        assert_result(
            &at("var s = new String('hi'); String(delete s[0])"),
            "false",
        );
        assert_result(&at("var o = Object.create([1, 2, 3]); String(o[2])"), "3");
        // The write path and the read path agree about what an index names.
        assert_result(
            &at("var o = {}; o[4] = 'v'; String(o[4]) + o.hasOwnProperty(4) + (4 in o)"),
            "vtruetrue",
        );
    }
}

/// A Proxy whose TARGET is not an ordinary object must not mint either.
///
/// The post-trap invariant check has to name the key back to the target, and
/// the first attempt at this skipped the naming only for an ORDINARY target —
/// which is exactly the case where the check is vacuous. Every target for
/// which it is NOT vacuous still minted, so `new Proxy([], handler)` — the
/// commonest membrane shape there is — kept killing the engine from an
/// ordinary `for` loop. The target is asked BY INDEX now, so it answers out
/// of its side table without a name.
#[test]
fn a_proxy_over_an_exotic_target_mints_no_key() {
    for body in [
        "var p = new Proxy([], { get: function () { return 1; } }); p[i]",
        "var p = new Proxy([], { has: function () { return false; } }); i in p",
        "var p = new Proxy([], { getOwnPropertyDescriptor: function () {} }); \
         Object.getOwnPropertyDescriptor(p, i)",
        "var p = new Proxy([], { deleteProperty: function () { return true; } }); delete p[i]",
        "var p = new Proxy(new Uint8Array(2), { get: function () { return 1; } }); p[i]",
        // A proxy target that is itself a proxy re-opened it too.
        "var p = new Proxy(new Proxy({}, {}), { get: function () { return 1; } }); p[i]",
    ] {
        let src = format!("var n = 0; for (var i = 0; i < {NOVEL_INDICES}; i++) {{ {body}; }} n");
        let out = run(&src);
        assert!(out.completed, "MINTS -> halt {:?}: {body}", out.halt);
    }
}

/// Asking the target by index must not weaken the invariants it exists for.
#[test]
fn a_lying_trap_over_an_exotic_target_is_still_rejected() {
    for (setup, expr) in [
        (
            "var p = new Proxy(a, { get: function () { return 99; } });",
            "p[0]",
        ),
        (
            "var p = new Proxy(a, { has: function () { return false; } });",
            "0 in p",
        ),
        (
            "var p = new Proxy(a, { deleteProperty: function () { return true; } });",
            "delete p[0]",
        ),
    ] {
        assert_result(
            &format!(
                "var a = [7]; Object.freeze(a); {setup} var r = 'no-throw'; \
                 try {{ r = String({expr}); }} catch (e) {{ \
                   r = (e instanceof TypeError) ? 'TypeError' : 'other'; }} r"
            ),
            "TypeError",
        );
    }
    // An honest trap, and a configurable item, still answer normally.
    assert_result("String(new Proxy([7], {})[0])", "7");
    assert_result(
        "String(new Proxy([7], { get: function () { return 5; } })[0])",
        "5",
    );
}

/// `Object.prototype.propertyIsEnumerable` is a pure own-property PROBE.
#[test]
fn a_property_is_enumerable_probe_mints_no_key() {
    let src = format!(
        "var o = {{}}; var n = 0; \
         for (var i = 0; i < {NOVEL_INDICES}; i++) {{ if (o.propertyIsEnumerable(i)) n++; }} n"
    );
    let out = run(&src);
    assert!(out.completed, "MINTS -> halt {:?}", out.halt);
    assert_eq!(out.result, "0");
    for (source, want) in [
        ("String([1, 2].propertyIsEnumerable(0))", "true"),
        ("String([1, 2].propertyIsEnumerable(5))", "false"),
        ("String('ab'.propertyIsEnumerable(1))", "true"),
        ("String([1].propertyIsEnumerable('length'))", "false"),
        ("String(new Uint8Array(2).propertyIsEnumerable(1))", "true"),
        (
            "var o = {}; o[3] = 1; String(o.propertyIsEnumerable(3))",
            "true",
        ),
    ] {
        assert_result(source, want);
    }
}

/// A trap that NAMES the index mid-flight must not escape its invariant.
///
/// The post-trap check asks the target by index, and the index arms answer out
/// of the side tables on the premise that no ordinary slot can exist under a
/// name the table never held. A trap invalidates that premise the moment it
/// names the index: `Object.defineProperty(t, 888881, …)` — or merely
/// `t[888881] = 1; Object.freeze(t)` — promotes it to an ordinary slot the
/// index arm cannot see, and the check was silently skipped, letting a trap
/// contradict a non-configurable target property. The name spelling of the
/// same program always threw.
///
/// It also fired the wrong way: a trap that names the index and then honestly
/// REPORTS it was rejected, because the check could not see the property the
/// target really had.
#[test]
fn a_trap_that_names_the_index_mid_flight_is_still_held_to_the_invariant() {
    let guard = |setup: &str, expr: &str| {
        format!(
            "{setup} var r = 'no-throw'; try {{ r = String({expr}); }} \
             catch (e) {{ r = (e instanceof TypeError) ? 'TypeError' : 'other'; }} r"
        )
    };
    let named = |i: u32, extra: &str| {
        format!("Object.defineProperty(t, {i}, {{ value: 1, configurable: false{extra} }})")
    };
    for (setup, expr) in [
        (
            format!(
                "var t = {{}}; var p = new Proxy(t, {{ get: function () {{ {}; return 2; }} }});",
                named(888881, ", writable: false")
            ),
            "p[888881]".to_string(),
        ),
        (
            "var t = {}; var p = new Proxy(t, { get: function () { \
               t[888885] = 1; Object.freeze(t); return 2; } });"
                .to_string(),
            "p[888885]".to_string(),
        ),
        (
            format!(
                "var t = {{}}; var p = new Proxy(t, {{ has: function () {{ {}; return false; }} }});",
                named(888882, "")
            ),
            "888882 in p".to_string(),
        ),
        (
            format!(
                "var t = {{}}; var p = new Proxy(t, {{ deleteProperty: function () {{ {}; return true; }} }});",
                named(888883, "")
            ),
            "delete p[888883]".to_string(),
        ),
        (
            format!(
                "var t = {{}}; var p = new Proxy(t, {{ getOwnPropertyDescriptor: function () {{ \
                   {}; return undefined; }} }});",
                named(888886, "")
            ),
            "Object.getOwnPropertyDescriptor(p, 888886)".to_string(),
        ),
    ] {
        let out = run(&guard(&setup, &expr));
        assert!(out.completed, "halt {:?}", out.halt);
        assert_eq!(out.result, "TypeError", "{setup} {expr}");
    }

    // The reverse direction: naming the index and then reporting it honestly
    // must NOT throw — the target really does have that property.
    let out = run(&guard(
        "var t = {}; var p = new Proxy(t, { getOwnPropertyDescriptor: function () { \
           Object.defineProperty(t, 888884, { value: 1, configurable: false }); \
           return { value: 1, configurable: false }; } });",
        "Object.getOwnPropertyDescriptor(p, 888884).value",
    ));
    assert!(out.completed, "halt {:?}", out.halt);
    assert_eq!(out.result, "1");

    // Honest traps are unaffected.
    assert_result("String(new Proxy([7], {})[0])", "7");
    assert_result(
        "String(new Proxy({}, { get: function () { return 5; } })[0])",
        "5",
    );
}
