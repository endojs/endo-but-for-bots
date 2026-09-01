//! Behavioral gate for the generic (array-like / sparse / proxy `this`) path of
//! `Array.prototype` methods — the arrays child of
//! the Ironhorse JS completion arc (garden issue 51). The dense fast path in
//! `call_native_method` handles a packed array; this suite exercises the MOP
//! fallback that `forEach`/`some`/`every`/`find*`/`indexOf`/`lastIndexOf`/
//! `includes`/`reduce`/`reduceRight`/`at`/`map`/`filter` take for a receiver
//! that is NOT a fully-dense array: a sparse array (holes, possibly filled
//! through the prototype chain), a plain array-*like* object (`{length, 0:…}`),
//! an accessor (getter) receiver, and a `Proxy` observed through its traps.
//!
//! Each snippet is dual-run against the XS differential oracle; the gate is
//! **result agreement where the oracle accepts the program** (`BothComplete` +
//! `result_agrees`) per the accuracy-over-parity doctrine — computron agreement
//! is advisory for a generic receiver.

use ironhorse_262::{dual_run, Agreement};

/// Assert a program completes on BOTH engines with the SAME completion value.
fn agrees(source: &str) {
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
// §1  Array-like objects ({length, 0:…}) — the largest non-dense category.
// -------------------------------------------------------------------------

#[test]
fn array_like_iteration_family() {
    // forEach visits present indices; the callback observes (value, index, O).
    agrees(
        "var o = {length: 3, 0: 'a', 1: 'b', 2: 'c'}; var out = []; \
         Array.prototype.forEach.call(o, function (v, i) { out.push(i + ':' + v); }); out.join(',')",
    );
    agrees(
        "var o = {length: 3, 0: 2, 2: 4}; var r = Array.prototype.map.call(o, \
         function (v, i, source) { return v + i + source.length; }); \
         '' + r.length + ',' + r[0] + ',' + r.hasOwnProperty('1') + ',' + r[2]",
    );
    agrees(
        "var o = {length: 4, 0: 1, 2: 3, 3: 4}; var r = Array.prototype.filter.call(o, \
         function (v) { return v % 2; }); \
         '' + r.length + ',' + r[0] + ':' + r[1]",
    );
    agrees(
        "var o = {length: 4, 0: 1, 1: 2, 2: 3, 3: 4}; \
         Array.prototype.reduce.call(o, function (a, b) { return a + b; }, 0)",
    );
    agrees(
        "var o = {length: 4, 0: 1, 1: 2, 2: 3, 3: 4}; \
         Array.prototype.reduceRight.call(o, function (a, b) { return a + '' + b; })",
    );
    agrees(
        "var o = {length: 3, 0: 10, 1: 20, 2: 30}; \
         Array.prototype.some.call(o, function (v) { return v === 20; })",
    );
    agrees(
        "var o = {length: 3, 0: 10, 1: 20, 2: 30}; \
         Array.prototype.every.call(o, function (v) { return v >= 10; })",
    );
    agrees(
        "var o = {length: 3, 0: 5, 1: 6, 2: 7}; \
         Array.prototype.find.call(o, function (v) { return v > 5; })",
    );
    agrees(
        "var o = {length: 3, 0: 5, 1: 6, 2: 7}; \
         Array.prototype.findIndex.call(o, function (v) { return v > 5; })",
    );
    agrees(
        "var o = {length: 3, 0: 5, 1: 6, 2: 7}; \
         Array.prototype.findLast.call(o, function (v) { return v > 5; })",
    );
    agrees(
        "var o = {length: 3, 0: 5, 1: 6, 2: 7}; \
         Array.prototype.findLastIndex.call(o, function (v) { return v > 5; })",
    );
}

#[test]
fn array_like_search_family_with_from_index() {
    agrees("Array.prototype.indexOf.call({length: 3, 0: 'x', 1: 'y', 2: 'x'}, 'x')");
    agrees("Array.prototype.indexOf.call({length: 3, 0: 'x', 1: 'y', 2: 'x'}, 'x', 1)");
    agrees("Array.prototype.indexOf.call({length: 3, 0: 'x', 1: 'y', 2: 'x'}, 'x', -1)");
    agrees("Array.prototype.indexOf.call({length: 3, 0: 'x', 1: 'y', 2: 'x'}, 'z')");
    agrees("Array.prototype.lastIndexOf.call({length: 3, 0: 'x', 1: 'y', 2: 'x'}, 'x')");
    agrees("Array.prototype.lastIndexOf.call({length: 3, 0: 'x', 1: 'y', 2: 'x'}, 'x', 1)");
    agrees("Array.prototype.lastIndexOf.call({length: 3, 0: 'x', 1: 'y', 2: 'x'}, 'x', -2)");
    agrees("Array.prototype.includes.call({length: 3, 0: 1, 1: NaN, 2: 3}, NaN)");
    agrees("Array.prototype.includes.call({length: 3, 0: 1, 1: 2, 2: 3}, 2, -1)");
    agrees("Array.prototype.includes.call({length: 3, 0: 1, 1: 2, 2: 3}, 4)");
}

#[test]
fn array_like_at_relative_index() {
    agrees("Array.prototype.at.call({length: 3, 0: 'a', 1: 'b', 2: 'c'}, 0)");
    agrees("Array.prototype.at.call({length: 3, 0: 'a', 1: 'b', 2: 'c'}, -1)");
    agrees("Array.prototype.at.call({length: 3, 0: 'a', 1: 'b', 2: 'c'}, 5) === undefined");
    agrees("Array.prototype.at.call({length: 3, 0: 'a', 1: 'b', 2: 'c'}, -9) === undefined");
}

// -------------------------------------------------------------------------
// §2  Sparse arrays and prototype-inherited holes (HasProperty walks the chain).
// -------------------------------------------------------------------------

#[test]
fn sparse_forEach_skips_holes() {
    agrees("var a = [1, , 3]; var out = []; a.forEach(function (v, i) { out.push(i); }); out.join(',')");
}

#[test]
fn sparse_reduce_skips_holes() {
    agrees("var a = [1, , 3]; a.reduce(function (x, y) { return x + y; }, 0)");
}

#[test]
fn sparse_indexOf_skips_holes() {
    agrees("var a = [1, , 3]; a.indexOf(undefined)");
}

#[test]
fn sparse_includes_reads_holes_as_undefined() {
    agrees("var a = [1, , 3]; a.includes(undefined)");
}

#[test]
fn sparse_find_visits_holes_as_undefined() {
    agrees("var a = [1, , 3]; var out = []; a.find(function (v) { out.push(v); return false; }); out.length");
}

#[test]
fn sparse_lastIndexOf_over_preallocated() {
    agrees("var a = new Array(4); a[3] = 'z'; a.lastIndexOf('z')");
}

#[test]
fn prototype_inherited_hole_is_visited() {
    // A hole whose index resolves through the prototype chain IS present to
    // HasProperty, so forEach visits it and indexOf can find it.
    agrees(
        "var a = [0, , 2]; Object.defineProperty(Array.prototype, '1', \
         {value: 'inherited', configurable: true}); \
         var seen; a.forEach(function (v, i) { if (i === 1) seen = v; }); \
         delete Array.prototype['1']; seen",
    );
    agrees(
        "var a = [0, , 2]; Array.prototype[1] = 'p'; var r = a.indexOf('p'); \
         delete Array.prototype[1]; r",
    );
    agrees(
        "var a = [1, , 3]; Array.prototype[1] = 2; \
         var r = a.map(function (v) { return v * 10; }); delete Array.prototype[1]; \
         '' + r.length + ',' + r[0] + ',' + r[1] + ',' + r[2]",
    );
}

#[test]
fn map_and_filter_observe_callback_mutation_and_species() {
    agrees(
        "var a = [1, , 3]; var r = a.map(function (v, i) { \
         if (i === 0) a[1] = 2; return v * 10; }); \
         '' + r.length + ',' + r[0] + ',' + r[1] + ',' + r[2]",
    );
    agrees(
        "function C(len) { this.createdLength = len; } var a = [1, , 3]; \
         a.constructor = {}; a.constructor[Symbol.species] = C; \
         var r = a.map(function (v) { return v + 1; }); \
         '' + (r instanceof C) + ',' + r.createdLength + ',' + r[0] + ',' + \
         r.hasOwnProperty('1') + ',' + r[2]",
    );
    agrees(
        "function C(len) { this.createdLength = len; } var a = [1, 2, 3]; \
         a.constructor = {}; a.constructor[Symbol.species] = C; \
         var r = a.filter(function (v) { return v > 1; }); \
         '' + (r instanceof C) + ',' + r.createdLength + ',' + r[0] + ',' + r[1]",
    );
}

// -------------------------------------------------------------------------
// §3  Accessor (getter) receivers — Get runs the getter through the MOP.
// -------------------------------------------------------------------------

#[test]
fn accessor_element_is_read_through_get() {
    agrees(
        "var o = {length: 2, get 0() { return 'g0'; }, get 1() { return 'g1'; }}; \
         var out = []; Array.prototype.forEach.call(o, function (v) { out.push(v); }); out.join(',')",
    );
    agrees(
        "var calls = 0; \
         var o = {length: 1, get 0() { calls++; return 42; }}; \
         Array.prototype.indexOf.call(o, 42); calls",
    );
}

// -------------------------------------------------------------------------
// §4  Proxy receivers — every access routes through the traps in spec order.
// -------------------------------------------------------------------------

#[test]
fn proxy_receiver_trap_sequence() {
    // The generic path issues Get("length"), then per present index a
    // HasProperty (forwarded to the target when no `has` trap) and a Get; the
    // proxy's `get` trap records the length read and each element read.
    agrees(
        "var log = []; \
         var target = {length: 2, 0: 'a', 1: 'b'}; \
         var p = new Proxy(target, { \
           get: function (t, k) { log.push('get:' + String(k)); return t[k]; } \
         }); \
         Array.prototype.forEach.call(p, function () {}); log.join(',')",
    );
    // reduce over a proxy folds the same values the target holds.
    agrees(
        "var p = new Proxy({length: 3, 0: 1, 1: 2, 2: 3}, {}); \
         Array.prototype.reduce.call(p, function (a, b) { return a + b; }, 100)",
    );
    // includes reads every index (no has) through the proxy.
    agrees(
        "var log = []; \
         var p = new Proxy({length: 2, 0: 7, 1: 8}, { \
           get: function (t, k) { log.push(String(k)); return t[k]; } \
         }); \
         var r = Array.prototype.includes.call(p, 8); r + '|' + log.join(',')",
    );
}

// -------------------------------------------------------------------------
// §5  Coercion / error edges — ToObject, ToLength, IsCallable, empty reduce.
// -------------------------------------------------------------------------

#[test]
fn bad_receiver_or_callback_throws_type_error() {
    // ToObject(undefined) / ToObject(null) throws a catchable TypeError.
    agrees(
        "var t = false; try { Array.prototype.forEach.call(undefined, function () {}); } \
         catch (e) { t = e instanceof TypeError; } t",
    );
    agrees(
        "var t = false; try { Array.prototype.reduce.call(null, function () {}); } \
         catch (e) { t = e instanceof TypeError; } t",
    );
    // A non-callable callback throws a catchable TypeError (after ToLength).
    agrees(
        "var t = false; try { Array.prototype.forEach.call({length: 1, 0: 1}, 42); } \
         catch (e) { t = e instanceof TypeError; } t",
    );
    agrees(
        "var t = false; try { Array.prototype.some.call({length: 0}, 'nope'); } \
         catch (e) { t = e instanceof TypeError; } t",
    );
    // reduce with no initial value over an empty / all-holes range throws.
    agrees(
        "var t = false; try { Array.prototype.reduce.call({length: 0}, function () {}); } \
         catch (e) { t = e instanceof TypeError; } t",
    );
    agrees(
        "var t = false; try { [, , ,].reduce(function () {}); } \
         catch (e) { t = e instanceof TypeError; } t",
    );
}

#[test]
fn length_is_coerced_via_to_length() {
    // A string / fractional / negative length coerces per ToLength before any
    // iteration.
    agrees("Array.prototype.indexOf.call({length: '2', 0: 9, 1: 9}, 9, 1)");
    agrees("var n = 0; Array.prototype.forEach.call({length: 2.9, 0: 1, 1: 2}, function () { n++; }); n");
    agrees("var n = 0; Array.prototype.forEach.call({length: -1, 0: 1}, function () { n++; }); n");
    agrees(
        "var order = []; \
         var o = {get length() { order.push('len'); return 1; }, get 0() { order.push('0'); return 5; }}; \
         Array.prototype.forEach.call(o, function () {}); order.join(',')",
    );
}
