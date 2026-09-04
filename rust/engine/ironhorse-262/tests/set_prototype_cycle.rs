//! `[[SetPrototypeOf]]` prototype-chain cycle refusal, dual-run against the
//! pinned XS oracle.
//!
//! Regression: OrdinarySetPrototypeOf's step-8 cycle walk was missing, so
//! `Object.setPrototypeOf(Object.prototype, Array.prototype)` installed a
//! prototype cycle and every later chain walk failed to terminate (test262
//! `built-ins/Object/setPrototypeOf/set-failure-cycle.js` and
//! `built-ins/Object/prototype/setPrototypeOf-with-different-values.js`,
//! recorded as ironhorse-hang in the full-sweep report).

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
fn direct_cycle_is_refused_with_type_error() {
    assert_result_agrees(
        "let a = {}; let caught = false; \
         try { Object.setPrototypeOf(a, a) } catch (e) { caught = e instanceof TypeError } \
         caught",
    );
}

#[test]
fn transitive_cycle_is_refused_with_type_error() {
    assert_result_agrees(
        "let a = {}; let b = Object.create(a); let c = Object.create(b); \
         let caught = false; \
         try { Object.setPrototypeOf(a, c) } catch (e) { caught = e instanceof TypeError } \
         caught && Object.getPrototypeOf(a) === Object.prototype",
    );
}

#[test]
fn intrinsic_cycle_is_refused_with_type_error() {
    assert_result_agrees(
        "let caught = false; \
         try { Object.setPrototypeOf(Object.prototype, Array.prototype) } \
         catch (e) { caught = e instanceof TypeError } \
         caught",
    );
}

#[test]
fn reflect_set_prototype_of_reports_cycle_as_false() {
    assert_result_agrees(
        "let a = {}; let b = Object.create(a); \
         Reflect.setPrototypeOf(a, b) === false && Object.getPrototypeOf(a) === Object.prototype",
    );
}

#[test]
fn acyclic_reparenting_still_succeeds() {
    assert_result_agrees(
        "let a = {}; let b = {x: 3}; Object.setPrototypeOf(a, b); a.x",
    );
    assert_result_agrees(
        "let a = {}; Object.setPrototypeOf(a, null); Object.getPrototypeOf(a) === null",
    );
}
