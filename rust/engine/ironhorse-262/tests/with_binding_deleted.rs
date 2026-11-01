//! A `with` object binding that vanishes between name resolution and the
//! read or store of the reference (a getter, `@@unscopables` getter, or the
//! right-hand side deleted it). Object Environment Record `SetMutableBinding`
//! step 3 makes a strict store a `ReferenceError`; XS's `GET_VARIABLE` finds no
//! slot and throws in both modes unless `typeof` reads it. Each snippet is
//! dual-run; the gate is result agreement where both engines complete.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the pinned XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert!(run.result_agrees, "{source}: {run:?}");
}

fn caught(body: &str) -> String {
    format!("var r; try {{ {body} r = 'none'; }} catch (e) {{ r = e.constructor.name; }} r")
}

#[test]
fn strict_store_to_a_deleted_binding_throws() {
    // Deleted by the right-hand side: plain assignment.
    agrees(&caught(
        "var scope = { x: 1 }; \
         with (scope) { (function () { 'use strict'; x = (delete scope.x, 2); })(); }",
    ));
    // Deleted by the getter a compound assignment and an update read.
    for op in ["x ^= 3", "x += 1", "x++", "--x"] {
        agrees(&caught(&format!(
            "var scope = {{ get x() {{ delete this.x; return 2; }} }}; \
             with (scope) {{ (function () {{ 'use strict'; {op}; }})(); }}"
        )));
    }
    // The ReferenceError precedes the store: nothing is recreated.
    agrees(
        "var scope = { x: 1 }; \
         try { with (scope) { (function () { 'use strict'; x = (delete scope.x, 2); })(); } } \
         catch (e) {} 'x' in scope",
    );
}

#[test]
fn sloppy_store_to_a_deleted_binding_recreates_it() {
    agrees(
        "var scope = { x: 1 }; \
         with (scope) { x = (delete scope.x, 2); } scope.x",
    );
}

#[test]
fn read_of_a_deleted_binding_throws_except_under_typeof() {
    for strict in ["", "'use strict';"] {
        agrees(&caught(&format!(
            "var env = {{ b: 0, get [Symbol.unscopables]() {{ delete env.b; return null; }} }}; \
             with (env) {{ (function () {{ {strict} b; }})(); }}"
        )));
        agrees(&format!(
            "var env = {{ b: 0, get [Symbol.unscopables]() {{ delete env.b; return null; }} }}; \
             with (env) {{ (function () {{ {strict} return typeof b; }})(); }}"
        ));
    }
    // A Proxy `with` object always answers its `get` trap.
    agrees(
        "var p = new Proxy({}, { has: () => true, get: () => 7 }); \
         with (p) { (function () { 'use strict'; return absent; })(); }",
    );
}
