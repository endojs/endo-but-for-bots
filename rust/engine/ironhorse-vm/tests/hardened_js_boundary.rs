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

// ---- F057, the *program* half: a strict Script's own declarations ------
//
// The tests above exercise a strict **function** writing a frozen global,
// which the interpreter's assignment arm already handled. A strict top-level
// **Script** was the gap: its `var`/function declarations were frame locals,
// so `globalThis.g` did not see them and a frozen global could not protect
// them. ECMA-262 GlobalDeclarationInstantiation makes them global-object
// properties whether or not the Script is strict.
//
// The pinned XS oracle cannot certify this half: the `xs-oracle` shim compiles
// every source with the `eval` builtin's flags, under which a strict program's
// `var`s legitimately stay eval-local. These are therefore oracle-free, and
// cross-checked against node driven through `vm.runInThisContext` (a faithful
// Script goal; `runInNewContext` is not — its contextified global is a proxy
// that reports `configurable: true` and throws on `Object.freeze(globalThis)`).

/// A strict Script's top-level `var`/function is a property of the global.
#[test]
fn a_strict_scripts_top_level_declarations_are_global_properties() {
    assert_eq!(eval("'use strict'; var g = 1; globalThis.g"), "1");
    assert_eq!(eval("var g = 1; globalThis.g"), "1", "the sloppy twin agrees");
    assert_eq!(eval("'use strict'; function f() {} typeof globalThis.f"), "function");
    // One binding, not two: the bare name and the property are the same cell.
    assert_eq!(eval("'use strict'; var g = 1; g = 2; globalThis.g"), "2");
    assert_eq!(eval("'use strict'; var g = 1; globalThis.g = 3; g"), "3");
}

/// A frozen global protects them, at the top level of a strict Script too.
#[test]
fn a_frozen_global_blocks_a_strict_scripts_own_top_level_assignment() {
    // `r` is lexical, so the report itself is not blocked by the freeze.
    assert_eq!(
        eval(
            "'use strict'; var g = 1; let r; Object.freeze(globalThis);              try { g = 2; r = 'assigned'; }              catch (e) { r = e.name + ':' + g + ':' + globalThis.g; } r",
        ),
        "TypeError:1:1",
    );
    // The sloppy control: the write fails silently and the value holds.
    assert_eq!(eval("var g = 1; Object.freeze(globalThis); g = 2; g"), "1");
}

/// `let`/`const`/`class` are not global properties, and a frozen global does
/// not block writing one.
#[test]
fn a_strict_scripts_top_level_lexicals_stay_lexical() {
    assert_eq!(
        eval(
            "'use strict'; let a = 1; const b = 2; class C {}              [typeof globalThis.a, typeof globalThis.b, typeof globalThis.C, a + b].join()",
        ),
        "undefined,undefined,undefined,3",
    );
    assert_eq!(eval("'use strict'; let a = 1; Object.freeze(globalThis); a = 2; a"), "2");
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
fn two_compartment_evaluations_do_not_share_a_heap() {
    // This pins the ABSENCE of requirement 5, not its presence, and is named
    // so: each `evaluate*` builds a fresh `Interp`, so a mutation of one
    // evaluation's `Object.prototype` cannot reach another because the two are
    // unrelated heaps. It therefore cannot fail while that remains true.
    //
    // MUST BE REVISITED AT THE REALM SPLIT. Under genuinely shared frozen
    // intrinsics the mutation would be rejected rather than succeed, and the
    // isolation asserted below would come from the freeze instead of from
    // disjoint heaps. The first assertion is deliberately only "the mutating
    // program ran", not "the mutation took effect", so that landing the realm
    // split does not require weakening a test that looks like it guards
    // isolation.
    let machine = Machine::new();
    let a = machine.new_compartment();
    let b = machine.new_compartment();
    let (mutate, mutate_symbols) =
        compile("Object.prototype.leak = 1; var r = typeof Object.prototype.leak; r");
    let (probe, probe_symbols) = compile("var r = typeof Object.prototype.leak; r");
    let ra = a.evaluate_with_symbols(&mutate, &mutate_symbols);
    assert!(ra.completed, "{:?}", ra.halt);
    let rb = b.evaluate_with_symbols(&probe, &probe_symbols);
    assert!(rb.completed, "{:?}", rb.halt);
    assert_eq!(rb.result, "undefined", "a sibling's mutation must not leak");
}

#[test]
fn a_name_keyed_endowment_is_not_a_binding() {
    // `define_global` records a name-keyed endowment that no evaluation reads:
    // the evaluators seed only the id-keyed map, because the bytecode addresses
    // a global by interned symbol id. Pinned so the documented inertness cannot
    // drift back into an implied binding.
    let machine = Machine::new();
    let mut c = machine.new_compartment();
    c.define_global("endowed", ironhorse_vm::Slot::integer(7));
    assert!(c.global("endowed").is_some(), "recorded on the lookup surface");
    let (bytecode, symbols) = compile("var r = typeof endowed; r");
    let outcome = c.evaluate_with_symbols(&bytecode, &symbols);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, "undefined", "name-keyed endowments are inert");
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
    // The `has` trap is logged too: a store against an object environment runs
    // `HasBinding` and then `SetMutableBinding`'s own `HasProperty`, so `has`
    // fires twice before `set`. That sequence is XS's own — the oracle agrees
    // byte for byte in `ironhorse-262/tests/with_statement_mop.rs` — so pinning
    // it here keeps a future "optimization" from dropping one of them.
    let r = eval(
        "var log = []; \
         with (new Proxy({x: 1}, {has: (t, k) => { log.push('has'); return true; }, \
                                  set: (t, k, v) => { log.push('set:' + k + '=' + v); return true; }})) { \
           x = 9; \
         } log.join()",
    );
    assert_eq!(r, "has,has,set:x=9");
}

#[test]
fn with_consults_unscopables_through_the_get_trap() {
    // Blocked by `@@unscopables`: the name resolves outward.
    let blocked = eval(
        "var x = 'outer'; var out = {}; \
         with (new Proxy({x: 'inner'}, {get: (t, k) => k === Symbol.unscopables ? {x: true} : t[k]})) { \
           out.v = x; \
         } out.v",
    );
    assert_eq!(blocked, "outer");
    // Control, and the half that makes the assertion above meaningful: with the
    // blocklist entry gone the SAME shape must bind the proxy's own property.
    // Without it the test would pass for the wrong reason — a `with` head whose
    // binding is never found at all also answers "outer".
    let bound = eval(
        "var x = 'outer'; var out = {}; \
         with (new Proxy({x: 'inner'}, {get: (t, k) => k === Symbol.unscopables ? undefined : t[k]})) { \
           out.v = x; \
         } out.v",
    );
    assert_eq!(bound, "inner");
}

#[test]
fn a_property_descriptor_is_read_through_the_mop_seam() {
    // `descriptor_from_object` must not be chain-only: a descriptor supplied as
    // a Proxy has to be read through its traps, or `defineProperty` installs a
    // silently wrong property with no throw and no named skip. Pinned here
    // because the design document cites the descriptor path alongside `with`.
    //
    // The target must actually CARRY `value`: `ToPropertyDescriptor` runs
    // `HasProperty(desc, 'value')` before `Get`, so over an empty target the
    // read never happens and `undefined` is the correct answer — which is why
    // the architecture review's own probe for this was a false positive.
    let r = eval(
        "var o = {}; var out = {}; \
         Object.defineProperty(o, 'k', new Proxy({value: 0}, {get: (t, k) => k === 'value' ? 7 : t[k]})); \
         out.v = String(o.k); out.v",
    );
    assert_eq!(r, "7");
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
