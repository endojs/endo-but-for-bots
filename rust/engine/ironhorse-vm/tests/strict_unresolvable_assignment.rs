//! ECMA-262 6.2.5.6 `PutValue` step 6: assigning to an **unresolvable**
//! reference is a `ReferenceError` in strict code, and creates a global
//! property only in sloppy code.
//!
//! `XS_CODE_SET_VARIABLE` performed the sloppy behavior unconditionally, so
//! `'use strict'; x = 0` silently created a global instead of throwing —
//! over-acceptance visible to any strict guest that relies on the rule to
//! catch a typo'd or undeclared name. XS spells the rule as `fxRunHas` on the
//! reference followed by the `XS_STRICT_FLAG` test (`xsRun.c`
//! `XS_CODE_SET_VARIABLE`), which is what the arm now does.
//!
//! Verified against node driven through `vm.runInThisContext` (a faithful
//! Script-goal reference; `vm.runInNewContext`'s contextified global is a
//! proxy with its own artifacts).

use ironhorse_vm::Interp;

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

/// Run one script on a fresh machine, answering the completion value.
fn run(src: &str) -> Result<String, String> {
    let (bytecode, names) = compile(src);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    let out = m.run(&bytecode);
    if out.completed {
        Ok(out.result)
    } else {
        Err(format!("{:?}", out.halt))
    }
}

/// Assert that `src`, run as strict code, throws a `ReferenceError`.
///
/// Wrapping it in `try`/`catch` proves the throw is a *catchable* realm error
/// reaching guest code rather than a host abort: an uncatchable halt would
/// leave the script incomplete and the constructor name unread.
fn expect_reference_error(src: &str) {
    let wrapped = format!(
        "'use strict'; var caught = 'no throw'; \
         try {{ {src} }} catch (e) {{ caught = e.constructor.name }} caught"
    );
    match run(&wrapped) {
        Ok(name) => assert_eq!(name, "ReferenceError", "for {src:?}"),
        Err(halt) => panic!("{src:?} did not complete: {halt}"),
    }
}

#[test]
fn strict_assignment_to_an_undeclared_name_throws_reference_error() {
    // The bare, uncaught form: the whole script must fail to complete.
    let halt = run("'use strict'; x = 0; x").expect_err("must throw");
    assert!(
        halt.contains("ReferenceError"),
        "expected a ReferenceError, got: {halt}"
    );

    expect_reference_error("x = 0");
}

#[test]
fn the_sloppy_twin_still_creates_the_global() {
    // The same program without the directive is *correct today* and must stay
    // correct: sloppy `PutValue` takes step 6.b's
    // `CreateGlobalVariableBinding` and the read answers the assigned value.
    assert_eq!(run("x = 0; x").expect("completes"), "0");
    assert_eq!(run("for (q of [1]) {} q").expect("completes"), "1");
}

#[test]
fn strict_compound_assignment_and_update_throw() {
    // These fault on the *read* half (`GetValue` 6.2.5.5), which already
    // raised — the assertion pins that they keep throwing a ReferenceError
    // rather than reaching the store and creating a global.
    expect_reference_error("x += 1");
    expect_reference_error("x -= 1");
    expect_reference_error("x++");
    expect_reference_error("++x");
    expect_reference_error("x--");
}

#[test]
fn strict_for_of_and_for_in_assignment_targets_throw() {
    // A bare assignment target in a `for` head has no read half at all: it
    // reaches `SET_VARIABLE` directly, so it is the store that must fault.
    expect_reference_error("for (x of [1]) {}");
    expect_reference_error("for (x in {a: 1}) {}");
}

#[test]
fn strict_destructuring_assignment_targets_throw() {
    // Destructuring assignment (as distinct from a destructuring *binding*)
    // reaches the same by-name store per target.
    expect_reference_error("[x] = [1]");
    expect_reference_error("({p: x} = {p: 1})");
    expect_reference_error("[x = 2] = []");
}

#[test]
fn a_strict_function_body_in_a_sloppy_program_throws() {
    // The strict register is per-code-unit, restored by `enter_call` for the
    // callee: a strict function's undeclared store faults even though the
    // enclosing program is sloppy.
    let src = "function f() { 'use strict'; x = 1 } \
               var caught = 'no throw'; \
               try { f() } catch (e) { caught = e.constructor.name } caught";
    assert_eq!(run(src).expect("completes"), "ReferenceError");

    // ...and the converse: returning to the sloppy caller's frame restores its
    // register, so the store after the strict callee still creates the global.
    let src = "function f() { 'use strict'; return 1 } f(); g1 = 2; g1";
    assert_eq!(run(src).expect("completes"), "2");
}

#[test]
fn typeof_an_undeclared_name_still_answers_undefined() {
    // ECMA-262 13.5.3.1 step 3.a: an unresolvable reference short-circuits
    // `typeof` to `"undefined"`. This is a *read*, so the new store-side
    // guard must not disturb it — and it must stay true in strict code.
    assert_eq!(run("'use strict'; typeof nope").expect("completes"), "undefined");
    assert_eq!(run("typeof nope").expect("completes"), "undefined");
}

#[test]
fn a_resolvable_name_still_assigns_in_strict_code() {
    // Every shape of resolvable binding must be untouched: a frame local, a
    // `let`, a top-level `var`, and an existing own global property.
    assert_eq!(run("'use strict'; var v = 1; v = 2; v").expect("completes"), "2");
    assert_eq!(run("'use strict'; let l = 1; l = 2; l").expect("completes"), "2");
    assert_eq!(
        run("'use strict'; function f() { var v = 1; v = 2; return v } f()")
            .expect("completes"),
        "2"
    );
    assert_eq!(
        run("'use strict'; globalThis.g = 1; g = 2; g").expect("completes"),
        "2"
    );
}

#[test]
fn an_inherited_only_name_is_resolvable_for_the_store() {
    // A bare name resolves through `HasProperty`, which walks the prototype
    // chain, so every `%Object.prototype%` member is a resolvable global name
    // and a strict assignment to one must NOT raise step 6. ironhorse's global
    // object carries a null prototype, so the store asks `%Object.prototype%`
    // directly — the case that separates that walk from an own-property test.
    assert_eq!(
        run("'use strict'; Object.prototype.pp = 1; pp = 2; globalThis.pp")
            .expect("an inherited-only name must not raise the unresolvable error"),
        "2"
    );
    assert_eq!(
        run("'use strict'; toString = 1; typeof toString").expect("completes"),
        "number"
    );

    // NOTE: `GET_VARIABLE` does not yet ask the same question — `typeof
    // toString` answers `"undefined"` here where XS answers `"function"`, and
    // reading an inherited-only name raises the unresolvable ReferenceError.
    // This test deliberately pins only the store half rather than the two
    // halves' agreement: they genuinely disagree today, and asserting the
    // agreement would pin the read side's bug as expected behavior.
    let inherited_read = run("Object.prototype.pp = 1; pp");
    assert!(
        inherited_read.is_err(),
        "read side unexpectedly resolves an inherited-only name ({inherited_read:?}) \
         — if `GET_VARIABLE` now walks the chain too, restore the agreement \
         assertion this note replaced"
    );
}

#[test]
fn a_non_writable_global_still_raises_type_error_not_reference_error() {
    // The pre-existing strict guard on a refused `[[Set]]` is a TypeError and
    // must not be shadowed: the name *is* resolvable, so step 6 never fires.
    let src = "'use strict'; \
               Object.defineProperty(globalThis, 'ro', { value: 1, writable: false }); \
               var caught = 'no throw'; \
               try { ro = 2 } catch (e) { caught = e.constructor.name } caught";
    assert_eq!(run(src).expect("completes"), "TypeError");
}

#[test]
fn the_guard_does_not_latch_across_cranks() {
    // Companion to `strict_crank_boundary.rs`: the register the new guard
    // reads is reset at crank entry, so a strict crank must not make a later
    // sloppy crank's undeclared store throw.
    let (b1, n1) = compile("'use strict'; var s = 0; s = 1; s");
    let (b2, n2) = compile("x = 0; x");

    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    let o1 = m.run(&b1);
    assert!(o1.completed, "strict crank: {:?}", o1.halt);

    let b2r = m.relink_crank(&b2, &n2).expect("relink");
    let o2 = m.run(&b2r);
    assert!(
        o2.completed,
        "the strict register latched across the crank boundary: {:?}",
        o2.halt
    );
    assert_eq!(o2.result, "0");
}
