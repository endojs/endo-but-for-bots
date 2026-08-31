//! GetIterator failure paths, dual-run against the pinned XS oracle.
//!
//! Regression: the `for_of` dispatch returned its TypeError halts directly
//! instead of raising them in-frame, so a `try` in the same activation — a
//! generator body around `yield*` (test262
//! `language/expressions/yield/star-rhs-iter-get-call-non-obj.js`) or a
//! plain function around a `for..of` over a non-iterable — never observed
//! the error and the machine aborted. Both paths now raise through
//! `raise_js` with XS's message ("iterator: not an object" for a
//! non-object iterator, "call: not a function" for an absent protocol).

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
fn yield_star_non_object_iterator_is_catchable_inside_the_generator() {
    assert_result_agrees(
        "var badIter = {}; badIter[Symbol.iterator] = function () { return 7; }; \
         var caught; \
         function* g() { try { yield * badIter; } catch (err) { caught = err; } } \
         var iter = g(); var result = iter.next(); \
         '' + (result.value === undefined) + ',' + result.done + ',' + \
         (caught instanceof TypeError) + ',' + caught.message",
    );
}

#[test]
fn for_of_iterator_type_errors_are_catchable_with_oracle_messages() {
    assert_result_agrees(
        "function msg(f) { try { f(); return 'no-throw'; } catch (e) { return e.constructor.name + ':' + e.message; } } \
         [ msg(function () { for (var x of 7) {} }), \
           msg(function () { for (var x of {}) {} }), \
           msg(function () { var it = {}; it[Symbol.iterator] = function () { return 7; }; for (var x of it) {} }), \
           msg(function () { var it = {}; it[Symbol.iterator] = function () { return null; }; for (var x of it) {} }) \
         ].join(' | ')",
    );
}

#[test]
fn working_iterators_still_iterate() {
    assert_result_agrees(
        "var it = {}; it[Symbol.iterator] = function () { var n = 0; return { next: function () { n += 1; return { value: n, done: n > 3 }; } }; }; \
         var sum = 0; for (var x of it) { sum += x; } sum",
    );
    assert_result_agrees(
        "function* g() { yield* [1, 2, 3]; } var s = 0; for (var v of g()) { s += v; } s",
    );
}
