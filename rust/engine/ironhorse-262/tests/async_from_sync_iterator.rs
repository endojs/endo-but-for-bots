//! `CreateAsyncFromSyncIterator` regressions (ECMA-262
//! sec-createasyncfromsynciterator). `for await` and an async generator's
//! `yield*` wrap a synchronous iterator in an AsyncFromSyncIterator that
//! awaits each step's value and closes the iterator when that value rejects.
//! An async `yield*` does not itself await what its delegate yields. Each test
//! runs the Rust engine and the pinned XS oracle, drains the microtask queue,
//! and compares the global `g` the program settles.

use ironhorse_262::{dual_run_async, Agreement};

fn assert_signal(source: &str, expected: &str) {
    let run = dual_run_async(source, "g").expect("XS oracle machine");
    assert_eq!(run.run.agreement, Agreement::BothComplete, "{:?}", run.run);
    assert_eq!(run.ironhorse_signal.as_deref(), Some(expected), "{source}");
}

#[test]
fn for_await_unwraps_promises_from_an_array() {
    assert_signal(
        "var g = ''; (async function () { var a = []; \
           for await (var x of [Promise.resolve(5), 6]) a.push(x); g = a.join(); \
         })().catch(function (e) { g = 'E' + e; });",
        "5,6",
    );
}

#[test]
fn for_await_drives_a_user_sync_iterator() {
    assert_signal(
        "var g = ''; var it = { [Symbol.iterator]() { var i = 0; return { \
           next() { i++; return { value: i, done: i > 3 }; } }; } }; \
         (async function () { var a = []; for await (var x of it) a.push(x); g = a.join(); \
         })().catch(function (e) { g = 'E' + e; });",
        "1,2,3",
    );
}

#[test]
fn rejected_value_closes_the_sync_iterator() {
    assert_signal(
        "var g = ''; var closed = 0; var it = { [Symbol.iterator]() { return { \
           next() { return { value: Promise.reject('no'), done: false }; }, \
           return() { closed++; return {}; } }; } }; \
         (async function () { for await (var x of it); })().then( \
           function () { g = 'resolved'; }, function (e) { g = e + ':' + closed; });",
        "no:1",
    );
}

#[test]
fn missing_throw_closes_the_sync_iterator_and_rejects() {
    assert_signal(
        "var g = ''; var closed = 0; var it = { [Symbol.iterator]() { return { \
           next() { return { value: 1, done: false }; }, \
           return() { closed++; return {}; } }; } }; \
         async function* f() { yield* it; } var gen = f(); \
         gen.next().then(function () { return gen.throw(new Error('x')); }).then( \
           function () { g = 'resolved'; }, \
           function (e) { g = e.constructor.name + ':' + closed; });",
        "TypeError:1",
    );
}

#[test]
fn async_yield_star_does_not_unwrap_an_async_delegate() {
    assert_signal(
        "var g = ''; var p = Promise.resolve(1); var delegate = { \
           [Symbol.asyncIterator]() { return { next() { \
             return { then(r) { r({ value: p, done: false }); } }; } }; } }; \
         async function* f() { yield* delegate; } \
         f().next().then(function (r) { g = String(r.value === p); });",
        "true",
    );
}

#[test]
fn return_without_a_sync_return_method_completes() {
    assert_signal(
        "var g = ''; var it = { [Symbol.iterator]() { return { \
           next() { return { value: 1, done: false }; } }; } }; \
         async function* f() { yield* it; } var gen = f(); \
         gen.next().then(function () { return gen.return(); }).then( \
           function (r) { g = r.value + ':' + r.done; }, function (e) { g = 'E' + e; });",
        "undefined:true",
    );
}
