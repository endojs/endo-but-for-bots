//! Async-generator and `for await` causal regressions. These execute both the
//! Rust engine and the pinned XS oracle, then inspect a post-microtask global.

use ironhorse_262::{dual_run, dual_run_async, Agreement};

fn assert_async_signal(source: &str, expected: &str) {
    let run = dual_run_async(source, "g").expect("XS oracle machine");
    assert_eq!(run.run.agreement, Agreement::BothComplete, "{:?}", run.run);
    assert!(run.run.result_agrees, "{:?}", run.run);
    assert_eq!(run.ironhorse_signal.as_deref(), Some(expected), "{source}");
}

#[test]
fn async_generator_yield_return_and_request_queue() {
    assert_async_signal(
        "var g=''; async function* f(){yield 1; return 2} var i=f(); \
         i.next().then(function(r){g+='a'+r.value+':'+r.done;}); \
         i.next().then(function(r){g+=',b'+r.value+':'+r.done;}); undefined",
        "a1:false,b2:true",
    );
}

#[test]
fn async_generator_awaits_before_yielding() {
    assert_async_signal(
        "var g=''; async function* f(){var x=await Promise.resolve(3); yield x+1} \
         f().next().then(function(r){g=''+r.value+':'+r.done;}); undefined",
        "4:false",
    );
}

#[test]
fn async_generator_throw_and_return_settle_promises() {
    assert_async_signal(
        "var g=''; async function* f(){yield 1} var i=f(); \
         i.return(Promise.resolve(7)).then(function(r){g='r'+r.value+':'+r.done;}); \
         i.throw(8).then(undefined,function(e){g+=',t'+e;}); undefined",
        "r7:true,t8",
    );
}

#[test]
fn for_await_consumes_a_sync_iterable() {
    assert_async_signal(
        "var g=''; async function f(){for await (var x of [1,2,3]) g+=x;} f(); undefined",
        "123",
    );
}

#[test]
fn for_await_break_closes_an_async_generator() {
    assert_async_signal(
        "var g=''; async function* values(){try{yield 1; yield 2}finally{g+='c'}} \
         async function consume(){for await(var x of values()){g+=x; break} g+='d'} \
         consume(); undefined",
        "1cd",
    );
}

#[test]
fn async_generator_next_expression_returns_a_promise_with_custom_argument_iterator() {
    let run = dual_run(
        "Array.prototype[Symbol.iterator]=function*(){yield this[0]}; \
         (async function*([x]){yield x})([1]).next()",
    )
    .expect("XS oracle machine");
    assert_eq!(run.agreement, Agreement::BothComplete, "{run:?}");
    assert_eq!(run.ironhorse_result, "[object Promise]", "{run:?}");
    assert!(run.result_agrees, "{run:?}");
}
