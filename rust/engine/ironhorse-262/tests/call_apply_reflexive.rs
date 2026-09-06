//! `Function.prototype.call` / `apply` invoked **reflexively** — with a
//! `.call`/`.apply` method, a promise resolving function, or a capability
//! executor as the receiver — must take the abstract-Call dispatcher, not the
//! `.call`/`.apply` opcode trampolines' native-frame fast path.
//!
//! The fast path built a native frame for any receiver carrying a
//! native-method marker and handed it to `call_native_method`, whose arms for
//! these markers are "never reaches here" refusals: `Function.prototype.apply
//! .call({}, {}, [])` halted `apply:unexpected` and `resolve.call(undefined, 1)`
//! halted `promise:resolving-fn-unexpected`. Those refusals are engine
//! invariants (the dispatcher reaching a method routed elsewhere), which the
//! differential now reports as hard failures — and an adversarial review of
//! that reclassification found these valid programs reaching them, including
//! checked-in test262 cases (`built-ins/Function/prototype/apply/this-not-
//! callable.js`, `…/call/S15.3.4.4_A13.js`). The trampolines now route such
//! receivers through `invoke_value`, which already handles them.
//!
//! These lock the **value**; the computron count on the `.apply` side of
//! the abstract route is a few units under XS's (the trampoline's bulk
//! array read and `invoke_value`'s `CreateListFromArrayLike` charge differ
//! from `fx_Function_prototype_apply`'s nested native frames), which the
//! differential reports as the advisory computron gap it is. Calibrating
//! that route is metering work, separate from restoring the right answer.

use ironhorse_262::{dual_run, Agreement};

/// Both engines must run `source` to completion with the same value.
fn agrees(source: &str) {
    let run = dual_run(source).expect("oracle machine");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "{source}: halt={:?} oracle_error={:?}",
        run.ironhorse_halt,
        run.oracle_error
    );
    assert!(
        run.result_agrees,
        "{source}: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result
    );
}

#[test]
fn apply_dot_call_on_a_non_callable_receiver_throws_a_catchable_type_error() {
    agrees(
        "var r; try { Function.prototype.apply.call({}, {}, []) } \
         catch (e) { r = e instanceof TypeError } r",
    );
    agrees(
        "var r; try { Function.prototype.apply.call(undefined, {}, []) } \
         catch (e) { r = e instanceof TypeError } r",
    );
}

#[test]
fn call_dot_call_on_a_non_callable_receiver_throws_a_catchable_type_error() {
    agrees(
        "var r; try { Function.prototype.call.call(undefined, {}) } \
         catch (e) { r = e instanceof TypeError } r",
    );
    agrees(
        "var r; try { Function.prototype.call.call({}) } \
         catch (e) { r = e instanceof TypeError } r",
    );
}

#[test]
fn call_and_apply_redispatch_a_callable_receiver() {
    agrees("Function.prototype.call.call(function () { return 1 })");
    agrees("Function.prototype.call.call(function (a) { return this.v + a }, { v: 2 }, 3)");
    agrees("Function.prototype.call.apply(function (a, b) { return a + b }, [null, 1, 2])");
    agrees("Function.prototype.apply.call(function (a, b) { return a * b }, null, [3, 4])");
    agrees("Function.prototype.apply.apply(function () { return this.v }, [{ v: 5 }, []])");
}

#[test]
fn the_same_receivers_invoked_through_an_accessor() {
    // The accessor paths (`invoke_getter`/`invoke_setter`) build the same
    // native frame the trampolines did, so they need the same route: a
    // `.call`/`.apply` or a promise resolving function installed as a getter
    // or setter reached `call_native_method`'s refusals too.
    // `Function.prototype.call` invoked as a getter receives the property's
    // receiver as its `this`, which is not callable, so both engines throw a
    // catchable TypeError — the answer, where the refusal was a halt.
    agrees(
        "var o = {}; Object.defineProperty(o, 'x', { get: Function.prototype.call }); \
         var r; try { o.x } catch (e) { r = e instanceof TypeError } r",
    );
    agrees(
        "var o = {}; Object.defineProperty(o, 'x', { get: Function.prototype.apply }); \
         var r; try { o.x } catch (e) { r = e instanceof TypeError } r",
    );
    agrees(
        "var o = {}; Object.defineProperty(o, 'x', { set: Function.prototype.call }); \
         var r; try { o.x = 1 } catch (e) { r = e instanceof TypeError } r",
    );
    agrees(
        "var g; new Promise(function (resolve) { g = resolve }); \
         var o = {}; Object.defineProperty(o, 'x', { get: g }); typeof o.x",
    );
}

#[test]
fn promise_resolving_functions_and_executors_invoked_reflexively() {
    agrees("var r; new Promise(function (resolve) { r = resolve.call(undefined, 7) }); r");
    agrees("var r; new Promise(function (_, reject) { r = reject.apply(null, [8]) }); r");
    agrees(
        "typeof Promise.resolve.call(function C(executor) { \
           executor.call(null, function () {}, function () {}) }, 1)",
    );
}
