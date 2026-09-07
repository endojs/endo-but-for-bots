//! No index-keyed operation that only READS the property world may mint a
//! property key — for `GET_PROPERTY_AT`, and for the nine other opcodes and
//! reflective natives that reach an index the same way.
//!
//! `intern_key` hands out a fresh `u16` (and meters a slot allocation) per
//! novel name, and the string-key table grows bottom-up into the top-down
//! symbol-key floor. That meet is a REFUSAL that poisons the machine — the
//! dispatch loop halts, the crank aborts, and the machine can no longer be
//! persisted — so it is not something a guest can catch. Every shape below
//! was therefore a denial of service on the whole engine from one line of
//! ordinary guest code; each halted with
//! `Unsupported("property-key:id-space-exhausted")` before the fix.
//!
//! XS mints nothing on any of these paths: `XS_CODE_GET_PROPERTY_AT` passes
//! `(XS_NO_ID, index)` straight to `mxBehaviorGetProperty`, `fxAt` takes its
//! index branch for a canonical index, `mxBehaviorDeleteProperty` and
//! `mxBehaviorHasProperty` take `(id, index)`, and `fxKeyAt` spells a Proxy
//! trap's key from `value.at.index` without touching the key table.
//!
//! Deliberately absent: `o[-i]` and `o[i + 0.5]`. Those name non-index string
//! keys, which XS interns too (`mxToString` + `fxNewName`), so exhausting the
//! table with them is the engine's documented limit — the premise of
//! `id_space_exhaustion.rs` — rather than a divergence.

use ironhorse_vm::{run_program_with_symbols, RunOutcome};

fn run(source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    run_program_with_symbols(&bytecode, &symbols)
}

/// 70,000 distinct indices is past the `u16` id space, so a shape that still
/// mints halts instead of completing.
fn probe(body: &str) {
    let src = format!("var n = 0; for (var i = 0; i < 70000; i++) {{ {body} }} n");
    let out = run(&src);
    assert!(out.completed, "STILL MINTS -> halt {:?}: {body}", out.halt);
}

macro_rules! probes {
    ($($name:ident: $body:expr,)*) => {
        $(#[test] fn $name() { probe($body); })*
    };
}

probes! {
    p_get:            "var o = {}; if (o[i] !== undefined) n++;",
    p_in:             "var o = {}; if (i in o) n++;",
    p_delete:         "var o = {}; delete o[i];",
    p_has_own:        "var o = {}; if (o.hasOwnProperty(i)) n++;",
    p_gopd:           "var o = {}; if (Object.getOwnPropertyDescriptor(o, i)) n++;",
    p_reflect_get:    "var o = {}; if (Reflect.get(o, i) !== undefined) n++;",
    p_reflect_has:    "var o = {}; if (Reflect.has(o, i)) n++;",
    p_reflect_del:    "var o = {}; Reflect.deleteProperty(o, i);",
    p_reflect_gopd:   "var o = {}; if (Reflect.getOwnPropertyDescriptor(o, i)) n++;",
    p_optional:       "var o = {}; if (o?.[i] !== undefined) n++;",
    p_destructure:    "var o = {}; var v; ({ [i]: v } = o); if (v !== undefined) n++;",
    p_array_get:      "var a = []; if (a[i] !== undefined) n++;",
    p_array_delete:   "var a = []; delete a[i];",
    p_array_in:       "var a = []; if (i in a) n++;",
    p_array_gopd:     "var a = []; if (Object.getOwnPropertyDescriptor(a, i)) n++;",
    p_array_has_own:  "var a = []; if (a.hasOwnProperty(i)) n++;",
    p_proxy_get:      "var p = new Proxy({}, {}); if (p[i] !== undefined) n++;",
    p_proxy_trapped:  "var p = new Proxy({}, { get: function () { return 1; } }); if (p[i] !== 1) n++;",
    p_proxy_in:       "var p = new Proxy({}, {}); if (i in p) n++;",
    p_proxy_in_trap:  "var p = new Proxy({}, { has: function () { return false; } }); if (i in p) n++;",
    p_proxy_delete:   "var p = new Proxy({}, {}); delete p[i];",
    p_proxy_gopd:     "var p = new Proxy({}, {}); if (Object.getOwnPropertyDescriptor(p, i)) n++;",
    p_ta_get:         "var t = new Uint8Array(4); if (t[i] !== undefined) n++;",
    p_ta_in:          "var t = new Uint8Array(4); if (i in t) n++;",
    p_ta_gopd:        "var t = new Uint8Array(4); if (Object.getOwnPropertyDescriptor(t, i)) n++;",
    p_ta_delete:      "var t = new Uint8Array(4); delete t[i];",
    p_string_get:     "var s = 'abc'; if (s[i] !== undefined) n++;",
    p_wrapper_get:    "var s = new String('abc'); if (s[i] !== undefined) n++;",
    p_wrapper_in:     "var s = new String('abc'); if (i in s) n++;",
    p_wrapper_hasown: "var s = 'abc'; if (s.hasOwnProperty(i)) n++;",
    p_wrapper_delete: "var s = new String('abc'); delete s[i];",
    p_bigint_get:     "if ((1n)[i] !== undefined) n++;",
    p_number_get:     "if ((5)[i] !== undefined) n++;",
    p_bool_get:       "if (true[i] !== undefined) n++;",
}

#[test]
fn p_super_get() {
    let out = run(
        "var n = 0; \
         class B {} \
         class C extends B { m() { for (var i = 0; i < 70000; i++) { if (super[i] !== undefined) n++; } return n; } } \
         (new C()).m()",
    );
    assert!(out.completed, "STILL MINTS -> halt {:?}: super[i]", out.halt);
}
