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

/// A compartment cannot lock down the realm it shares with its siblings, and
/// the invariant that makes that true is structural rather than a guard.
///
/// **This is SES's model, not an invention.** `packages/ses/src/permits.js`
/// lists `lockdown` in `universalPropertyNames` — "Properties of all global
/// objects" — so a SES compartment DOES see `lockdown`. It is powerless there
/// because a compartment cannot exist before lockdown has run, so the call
/// meets the idempotence check. XS reaches the same place from the other side:
/// `fx_lockdown` itself builds `mxCompartmentGlobal` (`xsLockdown.c:139`), so
/// compartments postdate the operation.
///
/// Ironhorse reproduces that with two machine kinds, which is one rule and not
/// a case table: **the engine binds `lockdown` exactly when the engine owns the
/// operation.**
///
/// * A FROZEN machine is locked down at construction, so its compartments
///   postdate lockdown exactly as SES's do. `lockdown` is visible and answers
///   `TypeError: lockdown already called`.
/// * An UNFROZEN machine (`freeze == false`) means the SES shim owns the
///   operation — the graph is left mutable precisely so `repairIntrinsics` can
///   run — so the engine does not bind `lockdown` at all. The shim installs its
///   own when it evaluates.
///
/// An earlier revision instead refused inside `do_lockdown` when
/// `environment.global_obj != realm.global_object()`. That was unfaithful (no
/// engine has such a check) and unsound: it read the AMBIENT environment, and
/// a boot `alloc_named_method` carries `global_env: NULL`, so the per-call
/// `switch_environment` no-oped and guest code steered it. Measured then — a
/// compartment queued `Promise.resolve(1).then(lockdown)`, an ordinary host
/// `Machine::collect()` parked the ambient environment on the default global,
/// and the job locked the shared realm: `direct = lockdown is not available to
/// a compartment` but `LOCKED AFTER JOB = true`. The promise-job route is the
/// reason this test exercises it explicitly below.
#[test]
fn a_compartment_cannot_lock_down_the_shared_realm() {
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(move || {
            let run = |c: &ironhorse_vm::Compartment, source: &str| -> String {
                let (code, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
                let outcome = c.evaluate_with_symbols(&code, &symbols);
                assert!(outcome.completed, "{source:.60}: {:?}", outcome.halt);
                outcome.result
            };

            // UNFROZEN: the shim owns lockdown, so the engine binds none --
            // and the promise-job route has nothing to queue.
            let unfrozen = ironhorse_vm::Machine::unfrozen_with_start_global_names(None);
            unfrozen
                .set_source_compiler(std::rc::Rc::new(TestCompiler))
                .expect("machine takes a compiler");
            let guest = unfrozen.compartment(Default::default());
            assert_eq!(
                run(&guest, "typeof lockdown"),
                "undefined",
                "an unfrozen machine leaves the operation to the SES shim"
            );
            assert_eq!(
                run(
                    &guest,
                    "try { Promise.resolve(1).then(lockdown); 'queued' } \
                     catch (e) { e.name }"
                ),
                "ReferenceError"
            );
            let _ = unfrozen.collect();
            unfrozen.run_promise_jobs();
            assert!(
                !unfrozen.intrinsics().is_locked_down(),
                "the promise-job route must not reach a realm the guest cannot name"
            );
            assert_eq!(
                run(&unfrozen.start_compartment(), "typeof lockdown"),
                "undefined",
                "not bound in the start compartment either -- the shim installs its own"
            );

            // FROZEN: SES's shape. Visible, and inert through idempotence.
            let frozen = ironhorse_vm::Machine::new();
            frozen
                .set_source_compiler(std::rc::Rc::new(TestCompiler))
                .expect("machine takes a compiler");
            let sibling = frozen.compartment(Default::default());
            assert_eq!(
                run(&sibling, "typeof lockdown"),
                "function",
                "SES lists lockdown in universalPropertyNames; a compartment sees it"
            );
            assert_eq!(
                run(
                    &sibling,
                    "try { lockdown(); 'LOCKED' } catch (e) { e.name + ': ' + e.message }"
                ),
                "TypeError: lockdown already called",
                "powerless by idempotence, which is exactly how SES makes it powerless"
            );
        })
        .unwrap()
        .join()
        .unwrap();
}

/// What the START COMPARTMENT looks like after a native `lockdown()`, and why
/// that is not the environment a confined guest should get.
///
/// **The two environments are different on purpose, and conflating them is the
/// easy mistake.** `fx_lockdown` attenuates the *compartment* global template
/// (steps 3 and 4, `xsLockdown.c:105-139`), not the start compartment. The
/// start compartment keeps the host's real `Date` and `Math`; the compartment
/// template gets `fx_Date_secure`/`fx_Date_now_secure`, whose `now()` is NaN.
/// So a `Date.now()` that still works after lockdown is CORRECT here and is not
/// a gap in the port.
///
/// Measured against the XS oracle, the two engines agree on every row of this
/// table but one: `Date.now() > 0` is `true` on XS and `false` on Ironhorse,
/// because Ironhorse's clock is deterministic and returns 0. That is a
/// pre-existing engine property, not a lockdown effect — `Date.now()` is a
/// number and is not NaN on both.
///
/// | row | value | why it matters |
/// |---|---|---|
/// | `harden` | `function` | `worker-peer.js` hardens every value it returns |
/// | `Compartment` | **`undefined`** | see below |
/// | `eval`/`Function` | callable, and they WORK | source evaluation is a worker's whole job |
/// | `globalThis` | NOT frozen, still extensible | endowments are assigned onto a global |
/// | `Object.prototype` | frozen | the integrity the worker locks down for |
/// | `Date.now()` | works, not NaN | start-compartment Date is INTACT, by design |
/// | `Date.prototype.constructor` | the inert stand-in, name `""` | step 2, on both engines |
/// | `({}).constructor.constructor` | `TypeError` | the reach step 2 closes |
///
/// **`eval` and `Function` keep working, and that is not an oversight.** Step 2
/// replaces the `constructor` PROPERTY on the function-family prototypes, not
/// the global bindings, so `Function('return 1+1')()` is still `2` on XS too.
/// What closes is the path from an arbitrary object to an evaluator
/// (`({}).constructor.constructor`), which is the one a confined guest would
/// otherwise use.
///
/// **What this means for `packages/thixotrope`.** Its Ironhorse worker boot
/// currently inlines the whole SES shim, deletes `globalThis.harden` so
/// `@endo/harden` picks SES's own, and calls the SHIM's
/// `lockdown({errorTaming, reporting, overrideTaming})`. Moving it to the
/// native `lockdown()` needs more than this table supplies, because a
/// thixotrope guest is supposed to run AS IF IN A COMPARTMENT, not in the
/// start compartment measured here. `worker-peer.js` builds that today with
/// `new Compartment()`, `Object.assign(compartment.globalThis, {E, Far,
/// harden})` and `compartment.evaluate(source)`; the isolation is the point,
/// since evaluated source must see only those three names.
///
/// So the missing piece is not just the `Compartment` constructor. It is the
/// compartment-global template itself — `fx_lockdown` steps 3 and 4, including
/// the attenuated `Date` and `Math` a guest should get instead of the host's —
/// which is this work's stated scope boundary (`fx_Compartment`,
/// `xsModule.c:2864`). Dropping the shim before that exists would evaluate
/// guest source against the SHARED `globalThis` with a real clock: a
/// confinement regression, not a migration.
///
/// If this test starts reporting `Compartment=function`, re-read it alongside
/// `designs/ironhorse-native-lockdown.md` § Known Gaps before assuming the
/// migration is unblocked — the constructor existing is necessary, not
/// sufficient.
#[test]
fn the_post_lockdown_start_compartment_keeps_its_date_and_lacks_a_compartment() {
    assert_eq!(
        result(
            r#"
            lockdown();
            var out = [];
            function t(label, f) {
              try { out.push(label + '=' + String(f())); }
              catch (e) { out.push(label + '=' + e.name); }
            }
            t('harden', function () { return typeof harden; });
            t('Compartment', function () { return typeof Compartment; });
            t('eval', function () { return typeof eval; });
            t('Function', function () { return typeof Function; });
            t('evalWorks', function () { return eval('1+1'); });
            t('FunctionWorks', function () { return Function('return 1+1')(); });
            t('globalThisFrozen', function () { return Object.isFrozen(globalThis); });
            t('ObjProtoFrozen', function () { return Object.isFrozen(Object.prototype); });
            t('hardenWorks', function () { return Object.isFrozen(harden({a: 1})); });
            t('canEndowGlobal', function () { globalThis.__x = 1; return globalThis.__x; });
            t('DateNowIsNumber', function () { return typeof Date.now() === 'number'; });
            t('DateNowIsNaN', function () { return Number.isNaN(Date.now()); });
            t('newDateWorks', function () { return new Date(0).getTime(); });
            t('DateProtoCtorInert', function () {
              return Date.prototype.constructor !== Date;
            });
            t('reachViaCtor', function () { return ({}).constructor.constructor('return 1')(); });
            out.join(' | ');
        "#
        ),
        "harden=function | Compartment=undefined | eval=function | Function=function | \
         evalWorks=2 | FunctionWorks=2 | globalThisFrozen=false | ObjProtoFrozen=true | \
         hardenWorks=true | canEndowGlobal=1 | DateNowIsNumber=true | DateNowIsNaN=false | \
         newDateWorks=0 | DateProtoCtorInert=true | reachViaCtor=TypeError",
        "the start compartment keeps a working Date and gains no Compartment; \
         the attenuated Date belongs to the compartment template, which is out of scope"
    );
}

/// Loading the SES shim AFTER a native `lockdown()` fails confusingly, on XS
/// too.
///
/// SES guards against a second lockdown with `seemsToBeLockedDown()`, a
/// six-term conjunction. A native `lockdown()` turns on the first five —
/// including `typeof globalThis.lockdown === 'function'`, which
/// `create_hardened_globals` now makes true on EVERY Ironhorse realm — and then
/// the sixth calls `globalThis.Date.prototype.constructor.now()` and expects
/// NaN.
///
/// **That expectation encodes SES's layout, not XS's.** SES's `lockdown()`
/// points `Date.prototype.constructor` at its `SharedDate`, the attenuated
/// constructor whose `now()` is NaN, so the term reads as "has the shared Date
/// been installed". `fx_lockdown` puts the INERT stand-in there instead
/// (step 2) and keeps its attenuated `Date` for the compartment global template
/// (steps 3-4). The stand-in's own keys are exactly `length`, `name` and
/// `prototype` — there is no `now` — so the guard THROWS instead of returning
/// true, and the guest sees `TypeError: call: not a function` rather than SES's
/// intended and documented `Already locked down but not by this SES instance
/// (SES_MULTIPLE_INSTANCES)`.
///
/// Measured on both engines — the six terms come back
/// `true|true|true|true|true|TypeError` on Ironhorse AND on the XS oracle — so
/// this is inherent to `fx_lockdown`'s shape, not an Ironhorse defect. Giving
/// the stand-in a `now` would fix SES's message at the cost of oracle fidelity,
/// and is deliberately not done; SES also states it "provides security only if
/// it runs first in a given realm", so a realm that has already run a native
/// lockdown is outside its threat model by SES's own terms.
///
/// The practical rule this pins: native `lockdown()` and the SES shim are
/// alternatives, not layers. `Machine::unfrozen_with_start_global_names` says
/// the same thing from the other side — the shim repairs intrinsics before
/// freezing them and cannot do that to a graph already frozen.
#[test]
fn the_ses_shims_already_locked_down_guard_throws_after_a_native_lockdown() {
    assert_eq!(
        result(
            r#"
            lockdown();
            var out = [];
            function t(label, f) {
              try { out.push(label + '=' + String(f())); }
              catch (e) { out.push(label + '=' + e.name); }
            }
            t('1_FnProtoCtorRewired', function () {
              return globalThis.Function.prototype.constructor !== globalThis.Function;
            });
            t('2_hardenIsFn', function () { return typeof globalThis.harden === 'function'; });
            t('3_lockdownIsFn', function () { return typeof globalThis.lockdown === 'function'; });
            t('4_DateProtoCtorRewired', function () {
              return globalThis.Date.prototype.constructor !== globalThis.Date;
            });
            t('5_DateNowIsFn', function () { return typeof globalThis.Date.now === 'function'; });
            t('6_inertDateNow', function () {
              return globalThis.Date.prototype.constructor.now();
            });
            out.join(' | ');
        "#
        ),
        "1_FnProtoCtorRewired=true | 2_hardenIsFn=true | 3_lockdownIsFn=true | \
         4_DateProtoCtorRewired=true | 5_DateNowIsFn=true | 6_inertDateNow=TypeError",
        "SES's guard expects its own SharedDate at Date.prototype.constructor; \
         fx_lockdown puts the inert stand-in there, so the guard crashes"
    );
}

/// What a host-made compartment does and does not confine after lockdown.
///
/// **This test previously overclaimed, and the correction is the point of it.**
/// It asserted that a host-made compartment "confines guest source", attributing
/// the whole property to `lockdown()`. Two things were wrong. Its guest
/// compartment had no source compiler, so the `eval`/`Function` routes halted on
/// `NotImplemented("eval:no-compiler")` rather than being exercised at all; and
/// `compartment_evaluator` mints each compartment a FRESH `eval` and `Function`
/// at global-build time, which step 2 never touches. With a compiler attached
/// and an unrestricted `global_names`, guest source evaluates.
///
/// That is not a leak — those evaluators are scoped to the compartment's own
/// `globalThis`, which is ordinary Compartment semantics and not unique to
/// lockdown. But it means the confinement is a CONJUNCTION, and the two halves
/// close different routes:
///
/// * `global_names` closes the direct `eval`/`Function` BINDINGS. Lockdown
///   cannot: they are per-compartment objects minted after it ran.
/// * `lockdown()` closes `({}).constructor.constructor`, the route through a
///   shared prototype. `global_names` cannot: `CompartmentOptions::global_names`
///   says so itself, and calls itself "not a security boundary".
///
/// Neither alone suffices, which is why both configurations are measured here.
#[test]
fn a_host_made_compartment_confines_guest_source_only_with_global_names() {
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(|| {
            let probe = r#"
                var out = [];
                function t(l, f) {
                  try { out.push(l + '=' + String(f())); }
                  catch (e) { out.push(l + '=' + e.name + ': ' + e.message); }
                }
                t('Function', function () { return typeof Function; });
                t('eval', function () { return typeof eval; });
                t('FunctionWorks', function () { return Function('return 2')(); });
                t('evalWorks', function () { return eval('3'); });
                t('reach', function () { return ({}).constructor.constructor('return 1')(); });
                t('ObjProtoFrozen', function () { return Object.isFrozen(Object.prototype); });
                t('startLeaked', function () { return typeof globalThis.__fromStart; });
                out.join(' | ');
            "#;
            let measure = |names: Option<Vec<String>>| -> String {
                // A FROZEN machine: the host owns lockdown and has already
                // performed it, so this is SES's ordering -- compartments
                // postdate the freeze.
                let machine = ironhorse_vm::Machine::new();
                machine
                    .set_source_compiler(std::rc::Rc::new(TestCompiler))
                    .expect("machine takes a compiler");
                let mut guest = machine.compartment(ironhorse_vm::CompartmentOptions {
                    global_names: names,
                    ..Default::default()
                });
                // The compartment needs its OWN compiler, or every evaluator
                // route halts on `eval:no-compiler` and the test proves nothing.
                guest.set_source_compiler(std::rc::Rc::new(TestCompiler));
                let (code, symbols) = ironhorse_compile::compile_atoms(probe).expect("compiles");
                let outcome = guest.evaluate_with_symbols(&code, &symbols);
                assert!(outcome.completed, "{:?}", outcome.halt);
                outcome.result
            };

            // Unrestricted: the guest has its OWN working evaluators. Ordinary
            // Compartment semantics -- they are scoped to its own global.
            assert_eq!(
                measure(None),
                "Function=function | eval=function | FunctionWorks=2 | evalWorks=3 | \
                 reach=1 | ObjProtoFrozen=true | startLeaked=undefined",
                "KNOWN GAP, pinned deliberately: `reach=1` means the evaluator reach is \
                 OPEN on a Machine. `Machine::new()` freezes through step 5 only and \
                 never runs step 2, so `Function.prototype.constructor` is still the \
                 real `Function`. Since a Machine is now the only thing that has \
                 compartments, this is every compartment in the system. Fixing it \
                 requires the boot-minted stand-ins first -- minting at freeze time \
                 would put them above `boot_slot_count` and make every Machine \
                 unsnapshottable. When this row becomes `TypeError: secure mode`, \
                 delete this note and the Known Gaps entry with it."
            );

            // Worker-shaped: a restricted list removes the direct bindings.
            // Both halves are needed, and this is the half `global_names` owns.
            assert_eq!(
                measure(Some(vec![
                    "Object".to_string(),
                    "String".to_string(),
                    "Number".to_string(),
                    "TypeError".to_string(),
                ])),
                "Function=undefined | eval=undefined | \
                 FunctionWorks=ReferenceError: get Function: undefined variable | \
                 evalWorks=ReferenceError: get eval: undefined variable | \
                 reach=1 | ObjProtoFrozen=true | startLeaked=undefined",
                "global_names closes the bindings; the prototype route stays open for \
                 the same KNOWN GAP as above, which is why neither half is sufficient \
                 on a Machine today"
            );
        })
        .unwrap()
        .join()
        .unwrap();
}
