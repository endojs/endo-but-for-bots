//! Super property references whose home object has a null prototype,
//! dual-run against the pinned XS oracle.
//!
//! Regression: `super.x = v` / `super[k] = v` inside a static method of a
//! class whose prototype has been set to null used to index the slot arena
//! with the null sentinel and panic the worker
//! (test262 `language/expressions/assignment/target-super-*-reference-null.js`).
//! GetValue/PutValue on such a reference performs ToObject(null), a
//! TypeError, raised only after the key and RHS have evaluated
//! (ECMA-262 6.2.5.5 / 6.2.5.6).

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str) {
    let dr = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        dr.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?}; oracle={:?} ironhorse={:?})",
        dr.ironhorse_halt,
        dr.oracle_result,
        dr.ironhorse_result,
    );
    assert!(
        dr.result_agrees,
        "`{source}` result divergence: oracle={:?} ironhorse={:?}",
        dr.oracle_result, dr.ironhorse_result,
    );
}

#[test]
fn set_super_identifier_null_base_throws_after_rhs() {
    assert_result_agrees(
        "var count = 0; class C { static m() { super.x = count += 1; } } \
         Object.setPrototypeOf(C, null); \
         let caught = false; try { C.m() } catch (e) { caught = e instanceof TypeError } \
         caught && count === 1",
    );
}

#[test]
fn set_super_computed_null_base_throws_after_rhs() {
    assert_result_agrees(
        "var count = 0; class C { static m() { super[0] = count += 1; } } \
         Object.setPrototypeOf(C, null); \
         let caught = false; try { C.m() } catch (e) { caught = e instanceof TypeError } \
         caught && count === 1",
    );
}

#[test]
fn get_super_identifier_null_base_throws() {
    assert_result_agrees(
        "class C { static m() { return super.x; } } \
         Object.setPrototypeOf(C, null); \
         let caught = false; try { C.m() } catch (e) { caught = e instanceof TypeError } \
         caught",
    );
}

#[test]
fn get_super_computed_null_base_throws_after_key() {
    assert_result_agrees(
        "var keyed = 0; class C { static m() { return super[keyed += 1]; } } \
         Object.setPrototypeOf(C, null); \
         let caught = false; try { C.m() } catch (e) { caught = e instanceof TypeError } \
         caught && keyed === 1",
    );
}

#[test]
fn non_null_super_bases_still_resolve() {
    assert_result_agrees(
        "class A { static get x() { return 40 } } class B extends A { static m() { return super.x + 2 } } B.m()",
    );
    assert_result_agrees(
        "class A {} class B extends A { static m() { super.y = 9; return this.y } } B.m()",
    );
}
