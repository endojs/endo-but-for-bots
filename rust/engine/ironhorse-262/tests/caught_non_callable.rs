//! Calling or constructing a non-callable value raises a catchable TypeError.
//! The throw happens before a callee frame is entered, so the interpreter must
//! resume the caller's handler rather than treating its bytecode address as a
//! function body. These cases cover the shape used by Test262's `assert.throws`
//! helper and explicit return values from the handler.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}");
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
    assert!(run.result_agrees, "results must agree for {source}");
}

#[test]
fn caught_non_callable_call_resumes_the_caller() {
    assert_result_agrees(
        "function f(callback) { try { callback(); } catch (e) { return; } return 'missed'; } f({})",
        "undefined",
    );
    assert_result_agrees(
        "function f(callback) { try { callback(); } catch (e) { return e instanceof TypeError; } return false; } f(1)",
        "true",
    );
}

#[test]
fn object_prototype_call_matches_test262_assert_throws_shape() {
    assert_result_agrees(
        "function assertThrows(fn) { try { fn(); } catch (e) { return e instanceof TypeError; } return false; } assertThrows(function () { Object.prototype(); })",
        "true",
    );
}

#[test]
fn caught_non_constructor_resumes_the_caller() {
    assert_result_agrees(
        "function assertThrows(fn) { try { fn(); } catch (e) { return e instanceof TypeError; } return false; } assertThrows(function () { new Object.prototype(); })",
        "true",
    );
}
