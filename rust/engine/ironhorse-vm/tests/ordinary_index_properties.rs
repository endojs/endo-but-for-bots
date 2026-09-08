//! An ordinary object keeps its integer-indexed properties BY INDEX.
//!
//! `intern_key` hands out a fresh `u16` per novel name and the table grows
//! into the meet with the symbol-key floor — a saturation guard that POISONS
//! the machine, uncatchably and unpersistably. Storing an ordinary object's
//! index properties as named slots therefore made this a denial of service on
//! the whole engine, from a loop no one would look at twice:
//!
//! ```js
//! var o = {}; for (var i = 0; i < 70000; i++) o[i] = i;
//! ```
//!
//! It was the root cause under `Object.assign({}, bigArray)`,
//! `{...bigArray}`, `var {length, ...rest} = bigArray` and
//! `JSON.parse(json, reviver)` — every shape that CREATES index properties on
//! a plain object.
//!
//! XS keeps them in an internal `XS_ARRAY_KIND` slot on the instance:
//! `fxOrdinarySetProperty` (`xsType.c:727`) grows one on the first index
//! write, `fxOrdinaryGetProperty` reads it back without scanning the named
//! chain, and `fxOrdinaryOwnKeys` queues its keys ahead of the named ones. No
//! property name is involved at any point.
//!
//! Two disciplines are pinned here. The loops prove the id space survives; the
//! assertions beside them prove every operation still answers exactly what it
//! answered before — because the cheap way to pass a "mints no key" test is to
//! stop doing the work. Every expected value was measured on the XS oracle.

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

/// Past the `u16` id space: before the fix each of these halted with
/// `Unsupported("property-key:id-space-exhausted")`.
const N: u32 = 70_000;

fn big_array() -> String {
    format!("var a = []; for (var i = 0; i < {N}; i++) a[i] = i;")
}

// ------------------------------------------------------- the DoS family

#[test]
fn writing_many_indices_on_an_ordinary_object_mints_no_key() {
    assert_result(
        &format!("var o = {{}}; for (var i = 0; i < {N}; i++) o[i] = i; Object.keys(o).length"),
        "70000",
    );
}

#[test]
fn object_assign_into_an_ordinary_target_mints_no_key() {
    assert_result(
        &format!("{} Object.keys(Object.assign({{}}, a)).length", big_array()),
        "70000",
    );
}

#[test]
fn spreading_a_large_array_into_an_object_mints_no_key() {
    assert_result(
        &format!("{} var r = {{...a}}; Object.keys(r).length", big_array()),
        "70000",
    );
}

#[test]
fn an_object_rest_pattern_over_a_large_array_mints_no_key() {
    assert_result(
        &format!(
            "{} var {{length, ...rest}} = a; Object.keys(rest).length",
            big_array()
        ),
        "70000",
    );
}

/// The parse builds the object before any reviver runs, so this used to
/// poison the machine without a single reviver call.
#[test]
fn a_reviver_over_a_large_index_keyed_object_mints_no_key() {
    assert_result(
        &format!(
            "var o = {{}}; for (var i = 0; i < {N}; i++) o[i] = i; \
             Object.keys(JSON.parse(JSON.stringify(o), function (k, v) {{ return v; }})).length"
        ),
        "70000",
    );
}

// ------------------------------------------------- the operations still work

#[test]
fn an_index_property_answers_every_way_it_is_asked() {
    assert_result(
        "var o = {}; o[0] = 1; o[1] = 2; JSON.stringify(o)",
        "{\"0\":1,\"1\":2}",
    );
    assert_result(
        "var o = {}; o[0] = 1; String(o[0]) + '|' + String(o['0']) + '|' + String(o[1])",
        "1|1|undefined",
    );
    assert_result(
        "var o = {}; o[0] = 1; JSON.stringify(Object.getOwnPropertyDescriptor(o, '0'))",
        "{\"value\":1,\"writable\":true,\"enumerable\":true,\"configurable\":true}",
    );
    assert_result(
        "var o = {}; o[0] = 1; String('0' in o) + '|' + String(0 in o) + '|' + String(1 in o)",
        // `0 in o` is `'0' in o`: the operator takes ToPropertyKey of its
        // left operand, so the number and the string name the same own
        // property and both answer true.
        "true|true|false",
    );
    assert_result(
        "var o = {}; o[0] = 1; String(o.hasOwnProperty('0')) + '|' \
         + String(o.propertyIsEnumerable('0'))",
        "true|true",
    );
    assert_result(
        "var o = {}; o[0] = 1; String(delete o[0]) + '|' + String(o[0]) + '|' \
         + Object.keys(o).length",
        "true|undefined|0",
    );
    // Index keys ascending, ahead of the named chain — `fxOrdinaryOwnKeys`.
    assert_result(
        "var o = {}; o.b = 1; o[2] = 1; o[1] = 1; Object.keys(o).join(',')",
        "1,2,b",
    );
    assert_result(
        "var o = {}; o[0] = 1; var r = []; for (var k in o) r.push(k); r.join('|')",
        "0",
    );
    assert_result(
        "var p = {}; p[0] = 'proto'; var o = Object.create(p); \
         String(o[0]) + '|' + String(o.hasOwnProperty('0'))",
        "proto|false",
    );
    assert_result(
        "var o = {}; o[4294967294] = 1; Object.keys(o).join('|')",
        "4294967294",
    );
}

#[test]
fn the_integrity_operations_still_bind_an_index_property() {
    assert_result(
        "var o = {}; o[0] = 1; Object.freeze(o); o[0] = 9; \
         String(o[0]) + '|' + String(Object.isFrozen(o))",
        "1|true",
    );
    assert_result(
        "var o = {}; o[0] = 1; Object.seal(o); String(delete o[0]) + '|' + String(o[0])",
        "false|1",
    );
    assert_result(
        "var o = {}; o[0] = 1; Object.preventExtensions(o); o[1] = 2; \
         String(o[1]) + '|' + Object.keys(o).length",
        "undefined|1",
    );
    assert_result(
        "var o = {}; o[0] = 1; harden(o); o[0] = 9; \
         String(o[0]) + '|' + String(Object.isFrozen(o))",
        "1|true",
    );
    // harden is transitive through the store.
    assert_result(
        "var o = {}; o[0] = {}; harden(o); o[0].x = 1; \
         String(Object.isFrozen(o[0])) + '|' + String(o[0].x)",
        "true|undefined",
    );
}

/// An accessor cannot live in the store (`self.accessors` is keyed by
/// `(instance, id)`), so the property PROMOTES to a named slot — carrying its
/// current attributes with it, or a redefinition would read as a creation and
/// silently reset `enumerable`.
#[test]
fn an_accessor_on_an_index_promotes_and_keeps_its_attributes() {
    assert_result(
        "var o = {}; o[0] = 1; Object.defineProperty(o, '0', {get: function () { return 9; }}); \
         String(o[0]) + '|' + Object.keys(o).join(',')",
        "9|0",
    );
    assert_result(
        "var o = {}; o[0] = 1; Object.defineProperty(o, '0', {get: function () { return 9; }}); \
         Object.defineProperty(o, '0', {value: 3}); \
         String(o[0]) + '|' + Object.keys(o).join(',')",
        "3|0",
    );
    assert_result(
        "var o = {}; o[0] = 1; Object.defineProperty(o, '0', {enumerable: false}); \
         Object.keys(o).length + '|' + String(o[0])",
        "0|1",
    );
}

/// Every "this index is provably absent" claim in the engine enumerates the
/// storages an index can live in, and adding one falsifies each of them. These
/// are the sites that got it wrong: the generic-Array answerability probe, the
/// `has` fallback, and both directions of the sparse-index skipper — the last
/// of which made `indexOf` answer `-1` over live elements.
#[test]
fn the_generic_array_methods_see_an_index_stored_by_index() {
    assert_result(
        "var o = {length: 2, 0: 'a', 1: 'b'}; \
         Array.prototype.map.call(o, function (x) { return x + '!'; }).join('|')",
        "a!|b!",
    );
    assert_result(
        "var o = {length: 2, 0: 'a'}; String(Array.prototype.indexOf.call(o, 'a'))",
        "0",
    );
    assert_result(
        "var o = {length: 3, 0: 'a', 2: 'c'}; String(Array.prototype.lastIndexOf.call(o, 'c'))",
        "2",
    );
    assert_result(
        "var o = {length: 3, 0: 'a', 2: 'c'}; \
         JSON.stringify(Array.prototype.filter.call(o, function () { return true; }))",
        "[\"a\",\"c\"]",
    );
    assert_result("Array.from({length: 3, 1: 'x'}).join('|')", "|x|");
    assert_result(
        "var o = {length: 2, 0: 'a', 1: 'b'}; Array.prototype.join.call(o, '-')",
        "a-b",
    );
    assert_result(
        "var o = {length: 3, 0: 'a', 2: 'c'}; var r = []; \
         Array.prototype.forEach.call(o, function (v, i) { r.push(i + ':' + v); }); r.join(',')",
        "0:a,2:c",
    );
    // The answer must not depend on whether some unrelated code interned the
    // index's NAME: an uninterned key takes the by-index path and an interned
    // one the by-id path, and both have to find the same property.
    assert_result(
        "var probe = {}; probe['0'] = 1; var o = {}; o[0] = 'a'; \
         String('0' in o) + '|' + String(o.hasOwnProperty('0')) + '|' + String(o[0])",
        "true|true|a",
    );
}

/// The index store's values are strong GC edges, walked by BOTH collectors —
/// the full one through `extra_edges` and the partial one through
/// `each_side_table_ref`. A referent reachable only as `o[0]` must survive a
/// collection; missing either walk hands its slot to the next allocation.
#[test]
fn a_referent_reachable_only_through_the_index_store_survives_collection() {
    assert_result(
        "var o = {}; o[0] = {tag: 'kept'}; \
         for (var i = 0; i < 40000; i++) { var junk = {a: i, b: [i]}; } \
         String(o[0].tag)",
        "kept",
    );
    // A string value there holds a chunk offset that full-GC compaction
    // rewrites; a missed remap leaves it dangling.
    assert_result(
        "var o = {}; o[0] = 'a string long enough to live in the chunk arena'; \
         for (var i = 0; i < 40000; i++) { var junk = 'garbage ' + i; } \
         o[0].length + '|' + o[0].slice(0, 8)",
        "47|a string",
    );
}
