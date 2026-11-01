//! An async function's `await` (and each `for await` step) on a native
//! promise runs `PromiseResolve(%Promise%, v)`, whose `v.constructor` read is
//! observable: a patched accessor runs once per await, and its throw is the
//! await's abrupt completion, caught by a `try` around the `await`. The async
//! generator half lives in `async_generators.rs`. Each snippet must complete
//! on both engines (agreement covers the oracle's microtask drain) and leave
//! ironhorse's global `g` at the expected value.

use ironhorse_262::{dual_run_async, Agreement};

fn drains_to(source: &str, expected: &str) {
    let a = dual_run_async(source, "g").expect("the XS oracle machine must start");
    assert_eq!(
        a.run.agreement,
        Agreement::BothComplete,
        "`{source}`: {:?}",
        a.run
    );
    assert_eq!(
        a.ironhorse_signal.as_deref(),
        Some(expected),
        "`{source}` ironhorse `g`"
    );
}

#[test]
fn a_throwing_constructor_getter_is_thrown_at_the_await() {
    drains_to(
        "var p = Promise.resolve(42); \
         Object.defineProperty(p, 'constructor', { get() { throw new Error('broken'); } }); \
         var g = ''; \
         (async function () { try { await p; g = 'no'; } catch (e) { g = e.message; } })();",
        "broken",
    );
}

#[test]
fn a_patched_prototype_constructor_is_read_once_per_await() {
    drains_to(
        "var g = 0; \
         Object.defineProperty(Promise.prototype, 'constructor', \
           { get() { g++; return Promise; }, configurable: true }); \
         (async function () { await Promise.resolve(1); await Promise.resolve(2); })();",
        "2",
    );
}

#[test]
fn for_await_reads_the_constructor_of_each_step_promise() {
    drains_to(
        "var g = 0; \
         var iterable = { [Symbol.asyncIterator]() { var i = 0; \
           return { next() { return Promise.resolve({ value: i, done: i++ > 1 }); } }; } }; \
         Object.defineProperty(Promise.prototype, 'constructor', \
           { get() { g++; return Promise; }, configurable: true }); \
         (async function () { for await (var x of iterable) {} })();",
        "3",
    );
}
