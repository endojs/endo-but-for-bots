//! The guest `lockdown()` (`Interp::do_lockdown`, `fx_lockdown` in
//! `c/moddable/xs/sources/xsLockdown.c`), and the properties that make it worth
//! having rather than just present.
//!
//! Three of `fx_lockdown`'s five steps land here; the two that presuppose a
//! guest `Compartment` do not. `designs/ironhorse-native-lockdown.md` § Scope
//! boundary says which and what that costs — briefly, the `ses-xs-parity`
//! `Symbol.toStringTag-lockdown.js` case still cannot run natively, because it
//! reads `Compartment.prototype`.
mod common;
use common::TestCompiler;

use ironhorse_vm::{parse_symbols, Interp};

/// Run `source` on a default machine — the shape `endot-ih`, `ironhorse-xst`
/// and the conformance harness all use, and the one whose `Intrinsics::roots`
/// is EMPTY (`Realm::new`). A `Machine`-built shared realm carries a populated
/// one; `lockdown_on_a_shared_realm_machine_*` below covers that side.
fn result(source: &str) -> String {
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn({
            let source = source.to_string();
            move || {
                let (code, symbols) = ironhorse_compile::compile_atoms(&source).unwrap();
                let mut machine = Interp::new();
                machine.set_source_compiler(std::rc::Rc::new(TestCompiler));
                machine.link_intrinsics(&parse_symbols(&symbols));
                let outcome = machine.run(&code);
                assert!(outcome.completed, "{:?}", outcome.halt);
                outcome.result
            }
        })
        .unwrap()
        .join()
        .unwrap()
}

/// `try { <expr> } catch (e) { e.name + ': ' + e.message }`, as a string, so a
/// refusal's exact message is asserted rather than merely its presence. The
/// message is XS's and is not a free choice — see `secure mode`, below.
const CATCH: &str = r#"
function attempt(f) {
  try { var v = f(); return 'returned ' + String(v); }
  catch (e) { return e.name + ': ' + e.message; }
}
"#;

#[test]
fn lockdown_is_a_guest_callable_global_that_returns_undefined() {
    assert_eq!(
        result("[typeof lockdown, typeof harden, typeof petrify, String(lockdown())].join(':')"),
        "function:function:function:undefined"
    );
}

#[test]
fn a_second_lockdown_throws_as_xs_does() {
    // `fx_lockdown` sets `XS_DONT_MARSHALL_FLAG` on `mxProgram` and a second
    // call is `TypeError("lockdown already called")` (`xsLockdown.c:88-92`).
    // The HOST-side `Interp::lock_down_intrinsics` is deliberately idempotent
    // instead; the split is documented on `do_lockdown` and in the design.
    assert_eq!(
        result(&format!(
            "{CATCH} lockdown(); attempt(function () {{ return lockdown(); }});"
        )),
        "TypeError: lockdown already called"
    );
}

#[test]
fn lockdown_closes_the_evaluator_reach_through_every_function_family_prototype() {
    // The measured hole this whole operation exists to close.
    // `CompartmentOptions::global_names` decides which names are BOUND and
    // nothing else, so a denied `Function` stays reachable through any
    // object's prototype chain. `fx_lockdown` step 2 is what closes it, and
    // only after a guest asks — which is why it cannot move into machine
    // construction.
    //
    // All four routes, because the three non-global evaluator constructors
    // (`%GeneratorFunction%`, `%AsyncFunction%`, `%AsyncGeneratorFunction%`)
    // have no global binding at all and are reachable ONLY this way.
    assert_eq!(
        result(&format!(
            r#"{CATCH}
            var routes = [
              function () {{ return ({{}}).constructor.constructor('return 1+1')(); }},
              function () {{ return (function*(){{}}).constructor('return 1+1'); }},
              function () {{ return (async function(){{}}).constructor('return 1+1'); }},
              function () {{ return (async function*(){{}}).constructor('return 1+1'); }},
            ];
            var before = routes.map(function (r) {{ return attempt(r).slice(0, 8); }});
            lockdown();
            var after = routes.map(attempt);
            [before.join(','), after.join(',')].join(' | ');
        "#
        )),
        "returned,returned,returned,returned | \
         TypeError: secure mode,TypeError: secure mode,\
         TypeError: secure mode,TypeError: secure mode"
    );
}

#[test]
fn the_inert_constructor_refuses_construction_as_loudly_as_a_call() {
    // `fx_lockdown_aux` stamps its duplicate `XS_CAN_CONSTRUCT_FLAG`
    // (`xsLockdown.c:60`) so that `new Function.prototype.constructor(src)`
    // fails as a SECURE-MODE refusal rather than as "not a constructor".
    // XS's `fxThrowTypeError` (`xsArguments.c:220`) branches on that same flag
    // and is why the message is `secure mode` and not `strict mode`.
    assert_eq!(
        result(&format!(
            r#"{CATCH}
            lockdown();
            var C = Function.prototype.constructor;
            [attempt(function () {{ return C('return 1'); }}),
             attempt(function () {{ return new C('return 1'); }})].join(' | ');
        "#
        )),
        "TypeError: secure mode | TypeError: secure mode"
    );
}

#[test]
fn the_inert_constructor_carries_the_shape_of_the_one_it_replaced() {
    // `length` comes from the constructor being replaced — 1 for the function
    // family, 7 for `Date` (`xsLockdown.c:94-103`, `:127`) — and the name is
    // empty because XS sets the duplicate's code ID to `XS_NO_ID` (`:61`).
    // SES's shim names each one; XS does not, and the oracle sees XS.
    assert_eq!(
        result(
            r#"
            lockdown();
            var F = Function.prototype.constructor, D = Date.prototype.constructor;
            [F.length, JSON.stringify(F.name), F.prototype === Function.prototype,
             D.length, D.prototype === Date.prototype,
             F === D].join(':')
        "#
        ),
        // A DISTINCT instance per prototype: `fx_lockdown_aux` duplicates
        // `%ThrowTypeError%` per call rather than sharing one stand-in, and
        // each duplicate carries its own `prototype` back-reference.
        "1:\"\":true:7:true:false"
    );
}

#[test]
fn date_keeps_working_while_its_prototype_constructor_goes_inert() {
    // Step 2's sixth call takes `Date.prototype` (`xsLockdown.c:127`), which is
    // the SHARED realm's prototype — so `Date.prototype.constructor` throws for
    // the host too, by design. The `Date` global is untouched: XS attenuates
    // that only into the compartment template, which ironhorse does not build.
    assert_eq!(
        result(&format!(
            r#"{CATCH}
            lockdown();
            [String(new Date(0).getTime()),
             String(Date.now() >= 0),
             attempt(function () {{ return Date.prototype.constructor(); }})].join(' | ');
        "#
        )),
        "0 | true | TypeError: secure mode"
    );
}

#[test]
fn lockdown_transitively_freezes_the_intrinsics() {
    // Step 5 (`xsLockdown.c:141-200`). XS walks an enumerated list; ironhorse
    // hardens every primordial instance, which is wider.
    assert_eq!(
        result(
            r#"
            var before = [Object.isFrozen(Object.prototype),
                          Object.isFrozen(Function.prototype),
                          Object.isFrozen(Array.prototype)].join(',');
            lockdown();
            var after = [Object.isFrozen(Object.prototype),
                         Object.isFrozen(Function.prototype),
                         Object.isFrozen(Array.prototype),
                         Object.isFrozen(Function.prototype.constructor)].join(',');
            before + ' | ' + after;
        "#
        ),
        // The inert constructor is frozen too. It is minted AFTER the root
        // enumeration takes its snapshot, so `do_lockdown` adds it explicitly;
        // an inert constructor left mutable would be a writable edge out of a
        // realm that claims to be frozen.
        "false,false,false | true,true,true,true"
    );
}

#[test]
fn lockdown_leaves_objects_the_guest_already_made_alone() {
    // The root set is bounded by `boot_slot_count`, not by `slots.capacity()`.
    // The construction-time freeze can use the whole arena because it runs
    // before any guest code; by the time a guest calls `lockdown()` the arena
    // is full of guest objects, and the same filter would freeze all of them.
    //
    // XS has no equivalent hazard -- it enumerates `stackIntrinsics` -- so this
    // is an ironhorse-specific way to get step 5 wrong, and nothing else in
    // this file would notice it.
    assert_eq!(
        result(
            r#"
            var mine = { a: 1 };
            var arr = [1, 2, 3];
            lockdown();
            mine.b = 2;
            arr.push(4);
            [Object.isFrozen(mine), mine.a + mine.b, arr.length,
             Object.isExtensible(mine)].join(':')
        "#
        ),
        "false:3:4:true"
    );
}

#[test]
fn lockdown_still_rewires_a_prototype_the_guest_has_already_hardened() {
    // THE regression test for the ordering, and a direct reproduction of how
    // the SES shim's `lockdown()` fails on ironhorse.
    //
    // `harden` walks prototype chains, so one `harden({})` leaves
    // `Function.prototype.constructor` `{writable: false, configurable: false}`
    // and `Object.isFrozen(Function.prototype)` true. A step 2 that went
    // through `[[DefineOwnProperty]]` would then be refused --
    // spec-correctly -- with `TypeError: invalid descriptor`, which is exactly
    // what `tame-function-constructors.js` gets.
    //
    // `install_locked_down_constructor` writes the slot directly, as
    // `fx_lockdown_aux` does, so the rewiring survives a guest that hardened
    // first. If this test ever fails with `invalid descriptor`, the write path
    // has been "fixed" into an ordinary define.
    assert_eq!(
        result(&format!(
            r#"{CATCH}
            harden({{}});
            var d = Object.getOwnPropertyDescriptor(Function.prototype, 'constructor');
            var frozenFirst = [Object.isFrozen(Function.prototype), d.writable, d.configurable]
              .join(',');
            var outcome = attempt(function () {{ return lockdown(); }});
            var reach = attempt(function () {{
              return ({{}}).constructor.constructor('return 1+1')();
            }});
            [frozenFirst, outcome, reach].join(' | ');
        "#
        )),
        "true,false,false | returned undefined | TypeError: secure mode"
    );
}

#[test]
fn harden_and_petrify_keep_working_after_lockdown() {
    // `harden` is itself hardened by step 5 (`xsLockdown.c:199`), which must
    // not make it uncallable.
    assert_eq!(
        result(
            r#"
            lockdown();
            var o = harden({ a: 1 });
            var p = petrify({ b: 2 });
            [Object.isFrozen(o), o.a, Object.isFrozen(p), p.b,
             Object.isFrozen(harden)].join(':')
        "#
        ),
        "true:1:true:2:true"
    );
}

#[test]
fn mutabilities_is_still_absent_and_says_so_plainly() {
    // `fx_mutabilities` (`xsLockdown.c:486`) and the `fxVerify*` audit family
    // are out of scope. The point of pinning it is the SHAPE of the absence: a
    // plain `ReferenceError`, not a `Halt::NotImplemented`. Two comments in
    // this tree claimed the latter for both `lockdown` and `mutabilities`, and
    // the claim was never measured. Do not infer a halt from an absence.
    assert_eq!(
        result(
            r#"
            var r;
            try { mutabilities({}); r = 'returned'; }
            catch (e) { r = e.name + ': ' + e.message; }
            [typeof globalThis.mutabilities, r].join(' | ');
        "#
        ),
        "undefined | ReferenceError: get mutabilities: undefined variable"
    );
}
