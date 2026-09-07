//! Differential regressions for the `with (expression) statement` object
//! environment routed through the **complete internal-method seam**
//! (architecture review F061). `fxIsScopableSlot`'s `HasProperty` and
//! `@@unscopables` read, and the `GET_VARIABLE`/`SET_VARIABLE` arms that
//! follow it, dispatch through `mop_has`/`mop_get`/`mop_set` rather than a
//! slot-chain walk, so:
//!
//! - a Proxy `with` object observes its `has`, `get` and `set` traps (a
//!   membrane's whole premise), and a trap throw is a catchable guest error;
//! - a store the object environment REJECTS (frozen, non-writable,
//!   getter-only, or a `set` trap answering false) throws a TypeError in
//!   strict code, where the `[[Set]]` failure flag was previously discarded;
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
//!    was never seen.
//! 2. **Newly correct paths whose cost was not yet calibrated.** The String
//!    wrapper (+1) and the exotic-`length` store (−1) answered the right value
//!    but had never had their cost measured against XS.
//!
//! **Four of those five are now closed** and gated [`exact`]; only the
//! `arguments` object still runs one computron heavy, and its residue is in
//! that exotic rather than in the scopable walk. Two corrections did it:
//!
//!  - The walk charged a whole `XS_CODE_METERING` per prototype **hop**. XS
//!    pays the `mxPushUndefined`/`mxPop` pair inside `fxOrdinaryHasProperty` —
//!    half a unit — per **frame**, meaning per level that does not find the
//!    property own. A hit at depth `d` runs `d` frames; a miss off the end of
//!    an ordinary chain runs a frame at the last object too, one more than the
//!    number of hops. `ORDINARY_HAS_PROPERTY_FRAME_METERING` charges that, and
//!    `XS_CODE_IN` shares it (see `in_operator_chain_metering.rs`).
//!  - `Array.prototype[@@unscopables]` did not exist, so an array head never
//!    paid for the blocklist get — and, worse than the cost,
//!    `with (anArray) { keys }` resolved to `Array.prototype.keys` instead of
//!    reading the enclosing `keys`. See the cluster at the end of this file.
//!
//! Proxy `with` remains [`result_only`]: before the seam change no trap ran
//! from a `with` head at all, so there was no meaningful cost to calibrate.
//! ironhorse runs XS's exact trap sequence and under-charges the host frames
//! around it — and that residual is **not** in this seam. The Proxy MOP is
//! under-metered with no `with` in the program at all: measured as the slope
//! over a repeated operation on a trapless `new Proxy({a: 1}, {})`, −2.0 units
//! per `'a' in p`, −3.0 per `p.a`, −7.0 per `p.a = 1`. A `with` read makes one
//! `[[HasProperty]]` and two `[[Get]]`s on the head, a store two
//! `[[HasProperty]]`s and a `[[Set]]`, so the figure tracks those controls.
//! Closing it means calibrating `proxy_has`/`proxy_get`/`proxy_set`, which
//! moves metering for every proxy program in the engine.
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

// ---- A rejected strict store throws ------------------------------------

#[test]
fn a_strict_store_into_a_with_object_throws_when_rejected() {
    // `with` is itself a strict-mode SyntaxError, but `S` on the Reference is
    // the strictness of the code containing the ASSIGNMENT, so a strict store
    // against an object environment is reachable two ways: a strict function
    // written in a sloppy `with` body and closing over it, and a strict direct
    // `eval` inside one. Both routes previously answered `'set'` where XS
    // throws a TypeError, for every rejecting shape.
    //
    // Route (a), a strict closure, over the three rejecting shapes:
    result_only(
        "var o={x:1}; var f; with(o){ f=function(){'use strict'; x=2; return 'set'; }; } \
         Object.freeze(o); var r='?'; try{ r=f(); }catch(e){ r=e.name; } r+':'+o.x",
    );
    result_only(
        "var o={}; Object.defineProperty(o,'x',{value:1,writable:false,configurable:true}); var f; \
         with(o){ f=function(){'use strict'; x=2; return 'set'; }; } \
         var r='?'; try{ r=f(); }catch(e){ r=e.name; } r+':'+o.x",
    );
    result_only(
        "var o={ get x(){ return 1; } }; var f; \
         with(o){ f=function(){'use strict'; x=2; return 'set'; }; } \
         var r='?'; try{ r=f(); }catch(e){ r=e.name; } r+':'+o.x",
    );
    // Route (b), a strict direct `eval` inside a sloppy `with`:
    result_only(
        "var o={x:1}; Object.freeze(o); var out={v:'no-throw'}; \
         with(o){ try{ eval(\"'use strict'; x = 2;\"); }catch(e){ out.v=e.name; } } out.v+':'+o.x",
    );
    // And a Proxy whose `set` trap answers false.
    result_only(
        "var p=new Proxy({x:1},{set:function(){ return false; }}); var f; \
         with(p){ f=function(){'use strict'; x=2; return 'set'; }; } \
         var r='?'; try{ r=f(); }catch(e){ r=e.name; } r",
    );
}

#[test]
fn a_sloppy_store_into_a_with_object_stays_silent() {
    // The controls that make the assertions above meaningful: the same rejecting
    // shapes in sloppy code must keep answering the RHS with no error, and a
    // setter that throws must surface ITS error rather than a TypeError.
    exact(
        "var o={x:1}; var f; with(o){ f=function(){ x=2; return 'set'; }; } \
         Object.freeze(o); var r='?'; try{ r=f(); }catch(e){ r=e.name; } r+':'+o.x",
    );
    exact(
        "var o={ get x(){ return 1; } }; var f; with(o){ f=function(){ x=2; return 'set'; }; } \
         var r='?'; try{ r=f(); }catch(e){ r=e.name; } r+':'+o.x",
    );
    // A binding that vanished between the reference and the store stays a
    // ReferenceError from the outer resolution, not a TypeError.
    exact(
        "var o={x:1}; var f; with(o){ f=function(){'use strict'; x=2; return 'set'; }; } \
         delete o.x; var r='?'; try{ r=f(); }catch(e){ r=e.name; } r+':'+('x' in o)+':'+o.x",
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
    // still resolves outward. Was two computrons heavy; the per-frame
    // correction to the scopable walk closed it.
    exact("var missing = 'outer'; var r = 0; with (new Uint8Array(2)) { r = missing; } r");
}

#[test]
fn with_array_write_targets_the_exotic_length() {
    // The parent commit answered `2:1`: the store went to the enclosing scope
    // and the array kept its length. Was one computron light; exact now that
    // the array head's `@@unscopables` blocklist exists to be consulted.
    exact("var a = [1, 2]; with (a) { length = 1; } a.length + ':' + a[0]");
}

#[test]
fn with_string_wrapper_binds_its_exotic_length() {
    // The parent commit answered `'outer'`. Was one computron heavy; the
    // per-frame correction closed it.
    exact("var length = 'outer'; var r = 0; with (new String('ab')) { r = length; } r");
}

#[test]
fn with_arguments_object_binds_its_length() {
    // Still one computron heavy, and the only one of the five recorded gaps the
    // per-frame correction did not close: the residue is in the `arguments`
    // exotic itself, not in the scopable walk, which is exact on every other
    // head kind at every depth.
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
    // A prototype-chain hit over-charged by one computron on the parent commit
    // and when this file was written. That was the walk charging a whole
    // `XS_CODE_METERING` per prototype *hop* where XS pays half a unit per
    // `fxOrdinaryHasProperty` frame; exact now.
    exact("var r = 0; with (Object.create({x: 44})) { r = x; } r");
}

// ---- `Array.prototype[@@unscopables]`: the blocklist an array head publishes

#[test]
fn array_unscopables_blocks_the_post_es5_methods() {
    // Not merely a cost: without the blocklist these resolved to the array
    // method instead of reading the enclosing binding.
    exact("var keys = 'outer'; var r; with ([]) { r = keys; } r");
    exact("var values = 'outer'; var r; with ([]) { r = values; } r");
    exact("var flat = 'outer'; var r; with ([]) { r = flat; } r");
    exact("var includes = 'outer'; var r; with ([]) { r = includes; } r");
}

#[test]
fn array_unscopables_does_not_block_es5_methods_or_length() {
    // `concat` predates the blocklist and `length` is not on it, so both still
    // resolve against the array.
    exact("var concat = 'outer'; var r; with ([]) { r = typeof concat; } r");
    exact("var length = 'outer'; var r; with ([1, 2, 3]) { r = length; } r");
}

#[test]
fn array_unscopables_object_shape() {
    exact("Array.prototype[Symbol.unscopables].keys");
    exact("typeof Array.prototype[Symbol.unscopables].concat");
    exact(
        "var d = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.unscopables); \
         '' + d.writable + ',' + d.enumerable + ',' + d.configurable",
    );
    // Non-enumerable on `Array.prototype` itself.
    exact("var n = 0; for (var k in Array.prototype) { n++; } n");
    exact("Array.prototype[Symbol.unscopables] === Array.prototype[Symbol.unscopables]");
}

#[test]
fn array_unscopables_key_order() {
    // Own-key order is observable, and XS's is NOT the specification's: it
    // lists `copyWithin` before `at`, and `values` before
    // `toReversed`/`toSorted`/`toSpliced`. Building the list in 23.1.3.35 order
    // (or in reverse, which insertion order made easy to get wrong) diverged
    // from the oracle on every enumeration below while leaving every `with`
    // case above passing — the blocklist's *behaviour* does not pin its
    // *shape*, so both need gating.
    exact("var a = []; for (var k in Array.prototype[Symbol.unscopables]) { a.push(k); } a.join(',')");
    exact("JSON.stringify(Array.prototype[Symbol.unscopables])");
}

#[test]
fn array_unscopables_is_ordinary_guest_state() {
    // The blocklist is a plain configurable/writable object: a guest can drop
    // it, swap it, extend it, or falsify an entry, and the walk follows.
    exact(
        "var keys = 'outer'; delete Array.prototype[Symbol.unscopables]; \
         var r; with ([]) { r = typeof keys; } r",
    );
    exact(
        "var keys = 'outer'; Array.prototype[Symbol.unscopables] = {}; \
         var r; with ([]) { r = typeof keys; } r",
    );
    exact(
        "var concat = 'outer'; Array.prototype[Symbol.unscopables].concat = true; \
         var r; with ([]) { r = concat; } r",
    );
    exact(
        "var keys = 'outer'; Array.prototype[Symbol.unscopables].keys = false; \
         var r; with ([]) { r = typeof keys; } r",
    );
}

#[test]
fn explicit_unscopables_on_an_exotic_head() {
    // An own `@@unscopables` on an array shadows `Array.prototype`'s, so the
    // blocklist the walk consults is the object's own.
    exact(
        "var keys = 'outer'; var o = []; o[Symbol.unscopables] = {}; \
         var r; with (o) { r = typeof keys; } r",
    );
    exact(
        "var length = 'outer'; var o = [1, 2, 3]; o[Symbol.unscopables] = {length: true}; \
         var r; with (o) { r = length; } r",
    );
}

// ---- The scopable walk at depth, and over boxed primitives ------------

/// A depth-3 prototype chain, `new C()` → `C.prototype` → `B.prototype` →
/// `A.prototype`. Built with constructors rather than `Object.create` or a
/// `__proto__` literal: both of those carry a small pre-existing metering
/// residual of their own (−1/4 and +1/4 of a code unit per object), which would
/// land here as setup noise and obscure what the walk costs.
const CHAIN: &str = "function A() {} function B() {} function C() {} \
                     B.prototype = new A(); C.prototype = new B(); ";

#[test]
fn prototype_chain_hit_at_each_depth() {
    exact("function C() {} C.prototype.a = 1; var o = new C(); var r; with (o) { r = a; } r");
    exact(&format!(
        "{CHAIN} B.prototype.a = 1; var o = new C(); var r; with (o) {{ r = a; }} r"
    ));
    exact(&format!(
        "{CHAIN} A.prototype.a = 1; var o = new C(); var r; with (o) {{ r = a; }} r"
    ));
}

#[test]
fn prototype_chain_total_miss_falls_through() {
    exact("var x = 9; function C() {} var o = new C(); var r; with (o) { r = x; } r");
    exact(&format!(
        "{CHAIN} var x = 9; var o = new C(); var r; with (o) {{ r = x; }} r"
    ));
}

#[test]
fn store_through_a_prototype_chain_targets_the_head() {
    exact(
        "function C() {} C.prototype.a = 1; var o = new C(); with (o) { a = 7; } \
         '' + o.a + ',' + C.prototype.a + ',' + o.hasOwnProperty('a')",
    );
}

#[test]
fn boxed_primitive_head_boxes_and_resolves() {
    // `fxToInstance`'s two `mxMeterOne` steps had been omitted; in the `with`
    // case that was masked by the old per-hop over-charge, so correcting the
    // walk unmasked it. Not `with`-specific — `var {length: n} = 'ab'` was
    // short by the same `1<<15`.
    exact("var x = 9; var r; with ('abc') { r = length; } r");
    exact("var x = 9; var r; with (0) { r = x; } r");
    exact("var x = 9; var r; with (10n) { r = x; } r");
    exact("var {length: n} = 'ab'; n");
}
