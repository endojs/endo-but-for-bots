//! A refused `[[Set]]` through a `with` object environment must throw a
//! TypeError in strict code, exactly as the global branch of the same opcode
//! already did for a refused global store.
//!
//! `XS_CODE_SET_VARIABLE`'s object-environment branch discarded `ordinary_set`'s
//! accepted/refused answer, on the reasoning — written into the code — that a
//! strict frame could never reach it because `with` is a strict-mode
//! SyntaxError. The `with` *statement* is; a strict function *written inside* a
//! sloppy `with` block is not, and it closes over that object environment. So
//!
//!     with (Object.freeze({ p: 1 })) { (function(){ 'use strict'; p = 2 })() }
//!
//! resolved `p` through this branch with the strict register set and silently
//! accepted the refused store. XS throws (`xsRun.c` `XS_CODE_SET_ALL`, the
//! `XS_STRICT_FLAG` tests on the refusal paths), and now so does the port.

use ironhorse_vm::Interp;

fn run(src: &str) -> Result<String, String> {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(src).expect("compiles");
    let names = ironhorse_vm::parse_symbols(&symbols);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    let out = m.run(&bytecode);
    if out.completed {
        Ok(out.result)
    } else {
        Err(format!("{:?}", out.halt))
    }
}

/// `src` runs inside a sloppy `with (o) { ... }`, in a callee of the given
/// strictness, answering the caught error's constructor name.
fn caught_in_with(setup: &str, strictness: &str, body: &str) -> String {
    let src = format!(
        "var caught = 'no throw'; {setup} \
         with (o) {{ try {{ (function(){{ {strictness} {body} }})() }} \
         catch (e) {{ caught = e.constructor.name }} }} caught"
    );
    run(&src).expect("completes")
}

const FROZEN: &str = "var o = Object.freeze({ p: 1 });";
const NON_WRITABLE: &str = "var o = {}; Object.defineProperty(o, 'p', \
                            { value: 1, writable: false, configurable: true });";

#[test]
fn a_strict_callee_throws_on_a_refused_with_binding_store() {
    assert_eq!(caught_in_with(FROZEN, "'use strict';", "p = 2"), "TypeError");
    assert_eq!(
        caught_in_with(NON_WRITABLE, "'use strict';", "p = 2"),
        "TypeError"
    );
}

#[test]
fn the_sloppy_callee_still_accepts_the_refused_store_silently() {
    // Sloppy `PutValue` discards the refusal and keeps the RHS as the result;
    // the property is unchanged.
    assert_eq!(caught_in_with(FROZEN, "", "p = 2"), "no throw");
    assert_eq!(caught_in_with(NON_WRITABLE, "", "p = 2"), "no throw");
    assert_eq!(
        run("var o = Object.freeze({ p: 1 }); with (o) { (function(){ p = 2 })() } o.p")
            .expect("completes"),
        "1"
    );
}

#[test]
fn an_accepted_with_binding_store_is_untouched_in_strict_code() {
    // The guard must fire only on a *refusal*: a writable binding still stores.
    assert_eq!(
        run("var o = { p: 1 }; with (o) { (function(){ 'use strict'; p = 2 })() } o.p")
            .expect("completes"),
        "2"
    );
    // ...and the strict callee really does resolve through the environment,
    // which is what makes this branch reachable with the register set.
    assert_eq!(
        run("var o = { p: 7 }; with (o) { var f = function(){ 'use strict'; return p }; } f()")
            .expect("completes"),
        "7"
    );
}

#[test]
fn a_name_the_with_walk_misses_is_still_the_unresolvable_reference_error() {
    // The two strict obligations of this opcode must not shadow each other: a
    // name the environment walk does not find is unresolvable, so it takes the
    // `PutValue` step 6 ReferenceError, not this TypeError.
    assert_eq!(
        caught_in_with("var o = { q: 1 };", "'use strict';", "zz = 2"),
        "ReferenceError"
    );
}
