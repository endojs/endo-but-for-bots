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
fn lockdown_poisons_an_accessor_constructor() {
    // A guest that replaces `Function.prototype.constructor` with a GETTER
    // before `lockdown()` must not keep its evaluator.
    //
    // This was a live bypass. XS distinguishes an accessor by `slot->kind`,
    // with the callables IN the slot value, so `fx_lockdown_aux`'s
    // kind-and-value assignment converts an accessor to a data property as a
    // side effect. Ironhorse keeps accessorness in the FLAG byte with the
    // callables in a side table, so "preserve the flag" -- correct for every
    // other bit -- preserved accessorness over a data write, the getter kept
    // answering, and `lockdown()` returned success with the reach wide open:
    //   lockdown=returned undefined | desc.get=function | reach=returned 2
    assert_eq!(
        result(&format!(
            r#"{CATCH}
            var Real = ({{}}).constructor.constructor;
            var FP = Object.getPrototypeOf(function () {{}});
            Object.defineProperty(FP, 'constructor',
              {{ get: function () {{ return Real; }}, configurable: true }});
            var ld = attempt(function () {{ return lockdown(); }});
            var d = Object.getOwnPropertyDescriptor(FP, 'constructor');
            var reach = attempt(function () {{
              return ({{}}).constructor.constructor('return 1+1')();
            }});
            ['ld=' + ld, 'get=' + typeof d.get, 'value=' + ('value' in d),
             'reach=' + reach].join(' | ');
        "#
        )),
        "ld=returned undefined | get=undefined | value=true | reach=TypeError: secure mode"
    );
}

#[test]
fn a_proxy_cannot_restore_the_evaluator_from_inside_the_freeze() {
    // Step 5 runs GUEST CODE: `do_harden` goes through the MOP, and a Proxy
    // hung off an early-hardened root (`Object.prototype` is the lowest-indexed
    // one) has its trap called while `Function.prototype` is still writable.
    //
    // This was a live bypass too, and a silent one -- `lockdown()` completed,
    // reported success, and left the real evaluator installed permanently:
    //   fired=true | lockdown=returned undefined | reach=returned 2
    //
    // No ordering of steps 2 and 5 fixes it, because the guest code runs
    // BETWEEN them by construction. `do_lockdown` re-asserts the constructor
    // slots after the harden loop instead.
    assert_eq!(
        result(&format!(
            r#"{CATCH}
            var Real = ({{}}).constructor.constructor;
            var fired = false;
            var evil = new Proxy({{}}, {{ preventExtensions: function (t) {{
              if (!fired) {{
                fired = true;
                try {{
                  Object.defineProperty(Function.prototype, 'constructor',
                    {{ value: Real, writable: true, enumerable: false, configurable: true }});
                }} catch (e) {{ /* already frozen on this root */ }}
              }}
              Object.preventExtensions(t); return true;
            }} }});
            Object.prototype.__evil__ = evil;
            var ld = attempt(function () {{ return lockdown(); }});
            var reach = attempt(function () {{
              return ({{}}).constructor.constructor('return 1+1')();
            }});
            ['fired=' + fired, 'ld=' + ld, 'reach=' + reach].join(' | ');
        "#
        )),
        // The trap still fires -- we do not police it, we outlast it.
        "fired=true | ld=returned undefined | reach=TypeError: secure mode"
    );
}

#[test]
fn the_inert_constructor_is_frozen_even_on_a_prototype_the_guest_hardened() {
    // What `roots.extend(minted)` is actually for. On a virgin realm, step 5's
    // transitive walk of `Function.prototype` reaches the constructor anyway,
    // so deleting that line changes nothing and no test notices. It matters
    // only when the guest hardened first: `do_harden` then short-circuits on
    // the already-frozen prototype and never reaches the stand-in minted
    // underneath it, leaving a writable edge out of a realm that reports itself
    // frozen. `Date.prototype` is the control -- it is not on that walk.
    assert_eq!(
        result(
            r#"
            harden({});
            lockdown();
            [Object.isFrozen(Function.prototype.constructor),
             Object.isExtensible(Function.prototype.constructor),
             Object.isFrozen(Date.prototype.constructor)].join(':')
        "#
        ),
        "true:false:true"
    );
}

#[test]
fn reflect_construct_refuses_with_the_same_secure_mode_message() {
    // `new C()` reaches native dispatch without an `IsConstructor` check, so it
    // cannot tell a `Native` from a `NativeMethod` and would pass either way.
    // `Reflect.construct` runs `IsConstructor` (7.2.4) first, which is the
    // check that forced `LockedDownConstructor` to be a `Native`. Without it
    // the refusal degrades to `TypeError: target: not a constructor` -- a
    // callability complaint where a secure-mode refusal belongs.
    assert_eq!(
        result(&format!(
            r#"{CATCH}
            lockdown();
            var C = Function.prototype.constructor;
            [attempt(function () {{ return Reflect.construct(C, []); }}),
             attempt(function () {{ return Reflect.construct(C, [], Object); }})].join(' | ');
        "#
        )),
        "TypeError: secure mode | TypeError: secure mode"
    );
}

#[test]
fn the_rewrite_preserves_the_constructor_propertys_other_flags() {
    // `fx_lockdown_aux` writes kind and value only, so a guest-set
    // `enumerable: true` survives the rewiring; step 5 then takes away
    // writable and configurable, and only those. Every prototype carries the
    // identical spec descriptor at boot, so without a guest-set flag the
    // preserved value and the fallback coincide and nothing observes the
    // difference.
    assert_eq!(
        result(
            r#"
            Object.defineProperty(Date.prototype, 'constructor',
              { value: Date, writable: true, enumerable: true, configurable: true });
            lockdown();
            var d = Object.getOwnPropertyDescriptor(Date.prototype, 'constructor');
            [d.enumerable, d.writable, d.configurable,
             Object.keys(Date.prototype).indexOf('constructor') >= 0].join(':')
        "#
        ),
        "true:false:false:true"
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

/// The `Machine` API -- the only one with compartments and `global_names`, and
/// so the one the confinement argument is about -- cannot reach step 2 at all.
///
/// `Realm` construction sets `locked_down: Cell::new(freeze)`, and
/// `Machine::new()` passes `freeze = true`. One `Cell<bool>` carries two
/// meanings: "the roots have been hardened", set at construction, and "step 2
/// has been applied", read by `do_lockdown`'s idempotence check. So on a
/// `Machine` the guest's first `lockdown()` is refused as a second one, the
/// constructors are never rewired, and the evaluator reach stays open on a
/// realm that reports `is_locked_down()`.
///
/// This is pinned rather than fixed: closing it means either splitting that
/// flag or running step 2 at construction, and both change what
/// `Machine::new()` hands back. `designs/ironhorse-native-lockdown.md` carries
/// it as the first open item. What must not happen is the gap closing silently
/// while the documents keep claiming the reach is shut -- so if this test
/// starts failing, the claim in the design note and the PR is the thing to fix
/// with it.
#[test]
fn a_frozen_machine_refuses_the_guest_lockdown_and_keeps_the_reach_open() {
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(move || {
            let machine = ironhorse_vm::Machine::new();
            machine
                .set_source_compiler(std::rc::Rc::new(TestCompiler))
                .expect("machine takes a compiler");
            let start = machine.start_compartment();
            let crank = |source: &str| {
                let (code, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
                let outcome = start.evaluate_with_symbols(&code, &symbols);
                assert!(outcome.completed, "{source:.60}: {:?}", outcome.halt);
                outcome.result
            };
            assert_eq!(
                crank(
                    r#"
                    var out = [];
                    out.push('frozen=' + Object.isFrozen(Object.prototype));
                    try { lockdown(); out.push('lockdown=returned'); }
                    catch (e) { out.push('lockdown=' + e.name + ': ' + e.message); }
                    out.push('reach=' + ({}).constructor.constructor('return 1+1')());
                    out.join(' | ');
                "#
                ),
                "frozen=true | lockdown=TypeError: lockdown already called | reach=2",
                "a Machine is hardened at construction but never rewired, and the \
                 guest cannot ask for it"
            );
        })
        .unwrap()
        .join()
        .unwrap();
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

/// Step 2 CREATES `constructor` when a guest deleted it first, and XS's
/// creation path leaves it enumerable.
///
/// `mxBehaviorSetProperty(..., mxID(_constructor), 0, XS_OWN)`
/// (`xsLockdown.c:98`) is a *set*, not a define: when the property is absent
/// it falls through `fxOrdinarySetProperty`'s creation branch (`xsType.c`),
/// which allocates with `fxNewSlot`, and a fresh XS slot carries no flags.
/// Step 5 then clears writable and configurable but never touches enumerable.
///
/// Measured against the oracle: `e=true w=false c=false`. Ironhorse defaulted
/// the absent case to `XS_DONT_ENUM_FLAG` and answered `e=false`. The bit is
/// small; the reason to pin it is that the *present* case and the *absent*
/// case want opposite defaults, and only the present case is obvious.
#[test]
fn a_deleted_constructor_is_recreated_enumerable() {
    assert_eq!(
        result(
            r#"
            delete Function.prototype.constructor;
            lockdown();
            var d = Object.getOwnPropertyDescriptor(Function.prototype, 'constructor');
            ['present=' + !!d, 'e=' + d.enumerable,
             'w=' + d.writable, 'c=' + d.configurable].join(' | ');
        "#
        ),
        "present=true | e=true | w=false | c=false",
        "XS re-creates the property with no flags, so it stays enumerable"
    );
}

/// The three globals the SES shim surface installs carry XS's names and
/// arities.
///
/// `xst.c:428-429` installs `harden`/1, `lockdown`/0, `petrify`/1. Ironhorse
/// built all three with `alloc_method`, which hard-codes `name_chunk = ""` and
/// arity 0, so the oracle read `lockdown=lockdown/0 harden=harden/1
/// petrify=petrify/1` against ironhorse's `lockdown=/0 harden=/0 petrify=/0`.
///
/// `name` and `length` are ordinary own data properties that `verifyProperty`
/// and `propertyHelper` read, so this is guest-observable, not cosmetic.
#[test]
fn the_hardened_globals_carry_their_xs_names_and_arities() {
    assert_eq!(
        result(
            r#"
            ['harden=' + harden.name + '/' + harden.length,
             'lockdown=' + lockdown.name + '/' + lockdown.length,
             'petrify=' + petrify.name + '/' + petrify.length].join(' | ');
        "#
        ),
        "harden=harden/1 | lockdown=lockdown/0 | petrify=petrify/1"
    );
}

/// A compartment cannot lock down the realm it shares with its siblings.
///
/// `lockdown()` rewrites `Function.prototype.constructor` and freezes the
/// whole intrinsic graph — state every compartment of a machine shares. XS
/// never faces this because `harden`/`lockdown`/`petrify` are test-shim
/// globals on the host global, and a compartment's global is built by
/// `fx_lockdown` from the intrinsics array, which does not contain them.
/// Ironhorse installs them as boot intrinsics, so any environment with an
/// unrestricted `global_names` gets the binding.
///
/// Measured before the guard: compartment B, which read
/// `frozen=false | rewired=false` moments earlier, read
/// `frozen=true | rewired=true` after compartment A called `lockdown()`.
///
/// The guard is on the call, not the binding — a compartment endowed with a
/// `lockdown` reference captured from the start realm would walk straight past
/// a hidden name. `typeof lockdown` therefore stays `"function"` here, and the
/// assertion pins that too so the check cannot be mistaken for a hidden name.
///
/// The realm's state is probed through `Function.prototype.constructor.name`
/// rather than through `Function.prototype.constructor !== Function`, which is
/// not a lockdown signal inside a compartment: `compartment_evaluator` hands
/// each compartment its own `Function` and `eval` instances, so that
/// comparison is already true before anything locks down. The name is the
/// discriminator step 2 actually moves — the real `Function` is named
/// `"Function"`, the inert stand-in is named `""` — and it needs no source
/// compiler, which a bare compartment does not carry.
#[test]
fn a_compartment_cannot_lock_down_the_shared_realm() {
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(move || {
            let machine = ironhorse_vm::Machine::unfrozen_with_start_global_names(None);
            machine
                .set_source_compiler(std::rc::Rc::new(TestCompiler))
                .expect("machine takes a compiler");
            let guest = machine.compartment(Default::default());
            let crank = |source: &str| {
                let (code, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
                let outcome = guest.evaluate_with_symbols(&code, &symbols);
                assert!(outcome.completed, "{source:.60}: {:?}", outcome.halt);
                outcome.result
            };
            assert_eq!(
                crank(
                    r#"
                    var out = [];
                    out.push('typeof=' + typeof lockdown);
                    try { lockdown(); out.push('call=returned'); }
                    catch (e) { out.push('call=' + e.name + ': ' + e.message); }
                    out.push('frozen=' + Object.isFrozen(Object.prototype));
                    out.push('ctor=' + JSON.stringify(Function.prototype.constructor.name));
                    out.join(' | ');
                "#
                ),
                "typeof=function | call=TypeError: lockdown is not available to a \
                 compartment | frozen=false | ctor=\"Function\"",
                "the binding is visible and inert; the realm is untouched"
            );
        })
        .unwrap()
        .join()
        .unwrap();
}
