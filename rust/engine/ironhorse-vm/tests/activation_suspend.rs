//! Activation fields and handler cuts survive each yield/await driver family.
use ironhorse_vm::run_program_with_symbols;

fn check(source: &str, expected: &str) {
    let (code, names) = ironhorse_compile::compile_atoms(source).expect("compile fixture");
    let out = run_program_with_symbols(&code, &names);
    assert!(out.completed, "{:?}", out.halt);
    assert_eq!(out.result, expected);
}

#[test]
fn generator_preserves_receiver_arguments_environment_and_handler() {
    check(
        "function* g(a) { with ({x:3}) { try { var n=100+(yield this.n+a+x); throw n; } \
         catch(e) { yield this.n+a+x+e; } } } \
         var it=g.call({n:2},5); [it.next().value,it.next(7).value,it.next().done]",
        "10,117,true",
    );
}

#[test]
fn async_function_preserves_receiver_arguments_environment_and_handler() {
    check(
        "var log=[]; async function f(a) { with ({x:3}) { \
         try { var n=100+(await 7); throw n; } catch(e) { log.push(this.n+a+x+e); } } } \
         f.call({n:2},5); log",
        "117",
    );
}

#[test]
fn async_generator_preserves_its_frame_across_yield_and_await() {
    check(
        "var log=[]; async function* g(a) { with ({x:3}) { \
         try { var n=100+(yield this.n+a+x); await 0; throw n; } \
         catch(e) { yield this.n+a+x+e; } } } \
         async function drain() { var it=g.call({n:2},5); \
         log.push((await it.next()).value); log.push((await it.next(7)).value); \
         log.push((await it.next()).done); } drain(); log",
        "10,117,true",
    );
}

#[test]
fn nested_sync_and_async_drivers_capture_the_innermost_activation() {
    check(
        "var log=[]; function* sync() { yield 2; } \
         async function helper() { await 0; return 3; } \
         async function* outer() { for (var x of sync()) { yield x; } \
         yield await helper(); } \
         async function drain() { var it=outer(); \
         log.push((await it.next()).value); log.push((await it.next(7)).value); \
         log.push((await it.next()).done); } drain(); log",
        "2,3,true",
    );
}
