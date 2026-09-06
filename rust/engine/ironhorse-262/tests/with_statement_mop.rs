//! Differential regressions for the `with (expression) statement` object
//! environment routed through the **complete internal-method seam**
//! (architecture review F061). `fxIsScopableSlot`'s `HasProperty` and
//! `@@unscopables` read, and the `GET_VARIABLE`/`SET_VARIABLE` arms that
//! follow it, dispatch through `mop_has`/`mop_get`/`mop_set` rather than a
//! slot-chain walk, so:
//!
//! - a Proxy `with` object observes its `has`, `get` and `set` traps (a
//!   membrane's whole premise), and a trap throw is a catchable guest error;
//! - an **exotic** own property — an array's or String wrapper's `length`, a
//!   function's `length`/`name` — is a scopable binding, where a chain-only
//!   walk saw none and let the name fall through to the enclosing scope.
//!   (Only NAMED exotic properties can be reached: an integer index is not a
//!   JavaScript identifier, so no `with` binding can ever name one.)
//!
//! Companion to `with_statement.rs`, which covers the ordinary-object cluster
//! and gates it bit-exact.
//!
//! **What the exotic half fixed.** These are not hypothetical: measured on the
//! parent commit (`f109e8f42`), four of the programs below answered a SILENT
//! WRONG VALUE, because the chain-only walk could not see an exotic own
//! property and let the name resolve outward instead.
//!
//! | program | XS | parent commit | here |
//! |---|---|---|---|
//! | `with ([1,2,3]) { length }` | `3` | `'outer'` | `3` |
//! | `with (function foo(a,b){}) { name+':'+length }` | `foo:2` | `'outer:outer'` | `foo:2` |
//! | `with (new String('ab')) { length }` | `2` | `'outer'` | `2` |
//! | `with (a) { length = 1 }` on `[1,2]` | `1:1` | `2:1` | `1:1` |
//!
//! The last one is the worst shape: the store went to the enclosing scope, so
//! the array kept its old length and the program saw no error.
//!
//! **Two gates, deliberately.** Where the path is bit-exact against the pinned
//! XS oracle it is gated bit-exact ([`exact`]). Where it is not, the case is
//! gated on **result agreement** ([`result_only`]) with the computron gap
//! stated in the test, rather than deleted or silently weakened. Every case in
//! this file agrees with XS on the completion VALUE; the residue is metering,
//! in two classes:
//!
//! 1. **Pre-existing ordinary-`with` drift**, untouched by the MOP routing and
//!    identical on the parent commit: a prototype-chain hit (+1), an
//!    `arguments` object (+1), and a TypedArray fall-through (+2).
//!    `with_statement.rs` never covered these shapes, which is why the drift
//!    was never seen. Not introduced here, and not fixed here either.
//! 2. **Newly correct paths whose cost is not yet calibrated.** The String
//!    wrapper (+1) and the exotic-`length` store (−1) answer the right value
//!    now and did not before, so their cost is being measured against XS for
//!    the first time. Proxy `with` is the same story at larger scale: before
//!    the seam change no trap ran from a `with` head at all, so there was no
//!    meaningful cost to calibrate; ironhorse now runs XS's exact trap
//!    sequence and under-charges the host frames around it. The
//!    `WITH_SCOPABLE_HAS_METERING` / `WITH_UNSCOPABLES_GET_METERING` constants
//!    were calibrated against the old chain-only walk.
//!
//! Recording the gap in an executing test is the point: a result regression
//! fails the build today, and the metering work has a named home rather than
//! living in a comment nobody runs.

use ironhorse_262::dual_run;

/// The program runs end-to-end bit-exact with the XS oracle (value + computrons).
fn exact(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert!(
        run.is_bit_exact(),
        "not bit-exact: {source}\n  oracle_result={} ironhorse_result={}\n  oracle_computrons={} ironhorse_computrons={}",
        run.oracle_result,
        run.ironhorse_result,
        run.oracle_computrons,
        run.ironhorse_computrons,
    );
}

/// The program agrees with the oracle on the completion VALUE, while its
/// computron count is a stated open gap (see the module documentation).
/// Both engines must still complete: an abort on either side fails here.
fn result_only(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert!(
        run.result_agrees,
        "result divergence: {source}\n  oracle_result={} ironhorse_result={} ironhorse_halt={:?}",
        run.oracle_result, run.ironhorse_result, run.ironhorse_halt,
    );
}

// ---- Proxy `with` objects: the traps must run -------------------------

#[test]
fn with_proxy_read_runs_the_has_and_get_traps() {
    // The target is EMPTY, so only the traps can produce the binding: a
    // chain-only walk answers ReferenceError here.
    result_only(
        "var r = 0; \
         with (new Proxy({}, {has: function (t, k) { return k === 'x'; }, \
                             get: function (t, k) { return k === 'x' ? 42 : undefined; }})) { r = x; } r",
    );
}

#[test]
fn with_proxy_write_runs_the_set_trap() {
    result_only(
        "var log = []; \
         with (new Proxy({x: 1}, {has: function () { return true; }, \
                                  set: function (t, k, v) { log.push(k + '=' + v); return true; }})) { x = 9; } \
         log.join()",
    );
}

#[test]
fn with_proxy_trap_order_is_observable_and_matches_xs() {
    // The strongest statement this file makes. The reference walk's `has`, the
    // `@@unscopables` read, and the following get/set are all guest-observable;
    // their ORDER and MULTIPLICITY are the membrane contract, and the completion
    // value here is the whole trap log. XS answers
    // `has:r,has:x,get:@@unscopables,get:x,has:x,get:@@unscopables,has:x,set:x`
    // — note `has` runs again before the store, and `@@unscopables` is consulted
    // once per reference. ironhorse reproduces it exactly.
    result_only(
        "var log = []; \
         var p = new Proxy({x: 1}, { \
           has: function (t, k) { log.push('has:' + String(k)); return k === 'x'; }, \
           get: function (t, k) { log.push('get:' + String(k)); return t[k]; }, \
           set: function (t, k, v) { log.push('set:' + String(k)); t[k] = v; return true; }}); \
         var r = 0; with (p) { r = x; x = 2; } log.join(',') + '|' + r",
    );
}

#[test]
fn with_proxy_unscopables_blocks_through_the_get_trap() {
    result_only(
        "var x = 'outer'; var r = 0; \
         with (new Proxy({x: 'inner'}, {get: function (t, k) { \
             return k === Symbol.unscopables ? {x: true} : t[k]; }})) { r = x; } r",
    );
}

#[test]
fn with_proxy_trap_throws_are_catchable() {
    // A trap that throws during the scopable walk, during the read, and during
    // the store: each is a catchable guest error, never a host escape that ends
    // the crank.
    result_only(
        "var r = 0; \
         try { with (new Proxy({}, {has: function () { throw new RangeError('h'); }})) { x; } } \
         catch (e) { r = e.name; } r",
    );
    result_only(
        "var r = 0; \
         try { with (new Proxy({x: 1}, {get: function () { throw new RangeError('g'); }})) { x; } } \
         catch (e) { r = e.name; } r",
    );
    result_only(
        "var r = 0; \
         try { with (new Proxy({x: 1}, {set: function () { throw new RangeError('s'); }})) { x = 2; } } \
         catch (e) { r = e.name; } r",
    );
}

#[test]
fn with_proxy_over_a_function_target_binds_the_callee() {
    result_only(
        "var r = 0; \
         with (new Proxy({}, {has: function (t, k) { return k === 'f'; }, \
                             get: function () { return function () { return typeof this; }; }})) { r = f(); } r",
    );
}

// ---- Exotic own properties are scopable bindings ----------------------

#[test]
fn with_array_binds_its_exotic_length() {
    // An array's `length` lives in the side table, not the slot chain; a
    // chain-only scopable walk missed it and let the name fall through to the
    // enclosing scope, so this answered `'outer'`. Bit-exact, metering included.
    //
    // Only the NAMED exotic properties are reachable this way: an integer index
    // is not a JavaScript identifier, so no `with` binding can name one. That is
    // why this file exercises `length`/`name` and not the index space.
    exact("var length = 'outer'; var r = 0; with ([1, 2, 3]) { r = length; } r");
}

#[test]
fn with_function_binds_its_length_and_name() {
    // A function's exotic `length`/`name`, likewise bit-exact.
    exact(
        "var name = 'outer'; var length = 'outer'; var r = 0; \
         with (function foo(a, b) {}) { r = name + ':' + length; } r",
    );
}

#[test]
fn with_typed_array_falls_through_for_an_absent_name() {
    // A TypedArray head binds no ordinary expando it does not have, so the name
    // still resolves outward. Gap class 1: the +2 here is present on the parent
    // commit too, with the same correct value.
    result_only("var missing = 'outer'; var r = 0; with (new Uint8Array(2)) { r = missing; } r");
}

#[test]
fn with_array_write_targets_the_exotic_length() {
    // The parent commit answered `2:1`: the store went to the enclosing scope
    // and the array kept its length. Gap class 2 for the cost (one light).
    result_only("var a = [1, 2]; with (a) { length = 1; } a.length + ':' + a[0]");
}

#[test]
fn with_string_wrapper_binds_its_exotic_length() {
    // The parent commit answered `'outer'`. Gap class 2 for the cost (one heavy).
    result_only("var length = 'outer'; var r = 0; with (new String('ab')) { r = length; } r");
}

#[test]
fn with_arguments_object_binds_its_length() {
    // Gap class 1: correct on both commits, one computron heavy on both.
    result_only(
        "function f() { var r = 0; with (arguments) { r = length + ':' + 0; } return r; } f(9, 8)",
    );
}

// ---- The ordinary path is unchanged -----------------------------------

#[test]
fn with_ordinary_accessor_is_unchanged() {
    exact("var r = 0; with ({get x() { return 43; }}) { r = x; } r");
    exact("var r = 0; var o = {}; var x = 9; with (o) { r = x; } r");
}

#[test]
fn with_prototype_chain_lookup_is_unchanged() {
    // Gap class 1: a prototype-chain hit over-charges by one computron on the
    // parent commit and on this one alike — the seam change did not move it.
    result_only("var r = 0; with (Object.create({x: 44})) { r = x; } r");
}
