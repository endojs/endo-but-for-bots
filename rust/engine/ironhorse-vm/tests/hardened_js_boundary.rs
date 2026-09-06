//! Hardened JavaScript as a security boundary (architecture review § 3.7,
//! executive-summary item 8: F015, F057, F058, F059, F061).
//!
//! Each primitive the SES layer rests on must deliver the invariant it
//! reports, never a success flag over a still-mutable object:
//!
//! - **F015** — a `harden` that throws part-way (a Proxy trap, a rejected
//!   define) must leave no stale visited mark, so a later `harden` of a
//!   reached-but-unfrozen object freezes it rather than short-circuiting.
//! - **F057** — a frozen or hardened `globalThis` is not writable through a
//!   bare identifier: sloppy code fails silently, strict code throws, and
//!   an undeclared name never mints a binding on a non-extensible global
//!   (strict code raises `ReferenceError` before the global is consulted).
//! - **F058** — arrays, collections and functions can be frozen and
//!   hardened, and every own-state write path they expose is rejected
//!   afterwards, so a realistic object graph can be hardened.
//! - **F059** — two compartments on one machine cannot observe each
//!   other's intrinsic mutations (the isolation half of requirement 5;
//!   the sharing half is recorded as undelivered in `compartment.rs`).
//! - **F061** — a `with` object environment routes `has`/`get`/`set` and
//!   the `@@unscopables` lookup through the complete internal-method seam,
//!   so a Proxy `with` object observes its traps and an accessor binding
//!   runs its getter; a chain-only walk would see through a membrane.

use ironhorse_vm::{Interp, Machine};

fn compile(src: &str) -> (Vec<u8>, Vec<u8>) {
    ironhorse_compile::compile_atoms(src).expect("compiles")
}

/// Run one crank on a fresh machine and return its completion value.
fn eval(src: &str) -> String {
    let (bytecode, symbols) = compile(src);
    let names = ironhorse_vm::parse_symbols(&symbols);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    let outcome = machine.run(&bytecode);
    assert!(outcome.completed, "{src}\n  halted: {:?}", outcome.halt);
    outcome.result
}

/// Run two cranks on one machine (the second relinked onto the first's
/// heap) and return the second's completion value.
fn eval_two_cranks(first: &str, second: &str) -> (String, String) {
    let (b1, s1) = compile(first);
    let mut machine = Interp::new();
    machine.link_intrinsics(&ironhorse_vm::parse_symbols(&s1));
    let o1 = machine.run(&b1);
    assert!(o1.completed, "crank 1 halted: {:?}", o1.halt);
    let (b2, s2) = compile(second);
    let relinked = machine
        .relink_crank(&b2, &ironhorse_vm::parse_symbols(&s2))
        .expect("relink");
    let o2 = machine.run(&relinked);
    assert!(o2.completed, "crank 2 halted: {:?}", o2.halt);
    (o1.result, o2.result)
}

// ---- F015: harden leaves no stale mark after an abort ------------------

#[test]
fn a_harden_that_throws_midway_leaves_no_stale_visited_mark() {
    // Crank 1 reaches `inner` through `o.a` and then throws on `o.b`'s
    // `ownKeys` trap. Crank 2 must be able to harden `inner` for real:
    // before the fix its visited mark survived the abort and `harden`
    // short-circuited on it, answering `"99:false"`.
    let (first, second) = eval_two_cranks(
        "var inner = {secret: 1}; \
         var o = {b: new Proxy({}, {ownKeys() { throw new Error('boom'); }}), a: inner}; \
         var r = 'ok'; try { harden(o); } catch (e) { r = 'caught'; } r",
        "var inner; var r; harden(inner); inner.secret = 99; \
         r = inner.secret + ':' + Object.isFrozen(inner); r",
    );
    assert_eq!(first, "caught", "the aborted harden is a catchable throw");
    assert_eq!(second, "1:true", "harden after an aborted walk still freezes");
}

// ---- F057: frozen global bindings by bare name -------------------------

#[test]
fn a_frozen_global_is_not_writable_by_bare_name_in_sloppy_code() {
    // `Object.freeze` is shallow, so `out` stays writable while `g` (an own
    // data property of `globalThis`) becomes non-writable.
    let r = eval("var g = 1; var out = {}; Object.freeze(globalThis); g = 2; out.v = g; out.v");
    assert_eq!(r, "1");
}

#[test]
fn a_frozen_global_assignment_throws_in_strict_code() {
    let r = eval(
        "var g = 1; var out = {v: 'no-throw'}; \
         (function () { 'use strict'; Object.freeze(globalThis); \
            try { g = 2; } catch (e) { out.v = e.name; } })(); \
         out.v + ':' + g",
    );
    assert_eq!(r, "TypeError:1");
}

#[test]
fn a_hardened_global_object_reports_frozen_and_is_frozen() {
    // `harden` is transitive, so nothing reachable from `globalThis` may
    // hold the probe's result; the IIFE's completion value carries it.
    let r = eval(
        "var g = 1; \
         (function () { harden(globalThis); g = 2; \
            return String(g) + ':' + Object.isFrozen(globalThis); })()",
    );
    assert_eq!(r, "1:true");
}

#[test]
fn an_undeclared_strict_assignment_is_a_reference_error_not_a_new_global() {
    let r = eval(
        "var out = {v: 'no-throw'}; \
         (function () { 'use strict'; Object.preventExtensions(globalThis); \
            try { zz = 2; } catch (e) { out.v = e.name; } })(); \
         out.v + ':' + typeof zz",
    );
    assert_eq!(r, "ReferenceError:undefined");
    // Strictness alone decides: an extensible global is no different.
    let r = eval(
        "var out = {v: 'no-throw'}; \
         (function () { 'use strict'; try { yy = 2; } catch (e) { out.v = e.name; } })(); \
         out.v + ':' + typeof yy",
    );
    assert_eq!(r, "ReferenceError:undefined");
}

#[test]
fn an_undeclared_sloppy_assignment_does_not_mint_a_binding_on_a_sealed_global() {
    let r = eval(
        "var out = {}; Object.preventExtensions(globalThis); zz = 2; \
         out.v = typeof zz + ':' + Object.isExtensible(globalThis); out.v",
    );
    assert_eq!(r, "undefined:false");
}

// ---- F058: exotic objects freeze and stay frozen -----------------------

#[test]
fn a_frozen_array_rejects_every_own_state_write() {
    let r = eval(
        "var a = [1]; var out = {}; Object.freeze(a); a[0] = 2; \
         try { a.push(3); } catch (e) { out.e = e.name; } \
         out.v = a.length + ':' + a[0] + ':' + Object.isFrozen(a) + ':' + out.e; out.v",
    );
    assert_eq!(r, "1:1:true:TypeError");
    let r = eval(
        "'use strict'; var a = [1, 2]; var out = {v: 'no-throw'}; Object.freeze(a); \
         try { a[0] = 9; } catch (e) { out.v = e.name; } \
         try { a.length = 0; } catch (e) { out.v += ':' + e.name; } \
         out.v + ':' + a[0] + ':' + a.length",
    );
    assert_eq!(r, "TypeError:TypeError:1:2");
}

#[test]
fn a_realistic_graph_hardens_and_every_member_is_frozen() {
    let r = eval(
        "var o = {a: [1, 2], m: new Map(), f() {}}; var out = {}; harden(o); \
         o.a[0] = 5; o.m.x = 1; o.f.y = 1; o.z = 1; \
         try { o.a.push(9); } catch (e) { out.e = e.name; } \
         out.v = [Object.isFrozen(o), Object.isFrozen(o.a), Object.isFrozen(o.m), \
                  Object.isFrozen(o.f), o.a.length, o.a[0], o.m.x, o.f.y, o.z, out.e].join(); \
         out.v",
    );
    assert_eq!(r, "true,true,true,true,2,1,,,,TypeError");
}

#[test]
fn a_hardened_function_keeps_its_name_against_redefinition() {
    let r = eval(
        "'use strict'; function f() {} var out = {v: 'no-throw'}; harden(f); \
         try { Object.defineProperty(f, 'name', {value: 'evil'}); } catch (e) { out.v = e.name; } \
         out.v + ':' + f.name + ':' + Object.isFrozen(f)",
    );
    assert_eq!(r, "TypeError:f:true");
}

// ---- F059: compartments cannot observe each other ----------------------

#[test]
fn a_compartment_cannot_observe_a_siblings_intrinsic_mutation() {
    let machine = Machine::new();
    let a = machine.new_compartment();
    let b = machine.new_compartment();
    let (mutate, mutate_symbols) =
        compile("Object.prototype.leak = 1; var r = typeof Object.prototype.leak; r");
    let (probe, probe_symbols) = compile("var r = typeof Object.prototype.leak; r");
    let ra = a.evaluate_with_symbols(&mutate, &mutate_symbols);
    assert!(ra.completed, "{:?}", ra.halt);
    assert_eq!(ra.result, "number");
    let rb = b.evaluate_with_symbols(&probe, &probe_symbols);
    assert!(rb.completed, "{:?}", rb.halt);
    assert_eq!(rb.result, "undefined", "a sibling's mutation must not leak");
}

// ---- F061: `with` over a Proxy or accessor -----------------------------

#[test]
fn with_over_a_proxy_resolves_through_its_has_and_get_traps() {
    let r = eval(
        "var out = {}; \
         with (new Proxy({}, {has: (t, k) => k === 'x', get: (t, k) => k === 'x' ? 42 : undefined})) { \
           out.v = x; \
         } out.v",
    );
    assert_eq!(r, "42");
}

#[test]
fn with_over_a_proxy_assigns_through_its_set_trap() {
    let r = eval(
        "var log = []; \
         with (new Proxy({x: 1}, {has: () => true, set: (t, k, v) => { log.push(k + '=' + v); return true; }})) { \
           x = 9; \
         } log.join()",
    );
    assert_eq!(r, "x=9");
}

#[test]
fn with_consults_unscopables_through_the_get_trap() {
    let r = eval(
        "var x = 'outer'; var out = {}; \
         with (new Proxy({x: 'inner'}, {get: (t, k) => k === Symbol.unscopables ? {x: true} : t[k]})) { \
           out.v = x; \
         } out.v",
    );
    assert_eq!(r, "outer");
}

#[test]
fn with_trap_and_getter_throws_are_catchable() {
    let r = eval(
        "var out = {}; \
         try { with (new Proxy({}, {has: () => { throw new RangeError('h'); }})) { x; } } \
         catch (e) { out.v = e.name; } out.v",
    );
    assert_eq!(r, "RangeError");
    let r = eval(
        "var out = {}; \
         try { with ({get x() { throw new RangeError('g'); }}) { x; } } \
         catch (e) { out.v = e.name; } out.v",
    );
    assert_eq!(r, "RangeError");
}

#[test]
fn with_over_a_proxy_passes_the_proxy_as_the_callee_this() {
    let r = eval(
        "var out = {}; \
         with (new Proxy({}, {has: (t, k) => k === 'f', \
                              get: (t, k) => k === 'f' ? function () { return typeof this; } : undefined})) { \
           out.v = f(); \
         } out.v",
    );
    assert_eq!(r, "object");
}
