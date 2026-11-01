//! `AsyncDisposableStack.prototype.disposeAsync`: a `null` or `undefined`
//! resource added by `use` still records a method-less entry, and
//! DisposeResources owes one `Await(undefined)` for it (`needsAwait` without
//! `hasAwaited`). The returned promise therefore settles one job turn later
//! than an empty stack's. Expected orders match the pinned XS oracle and
//! test262 `disposeAsync/explicit-await-for-{null,undefined}.js`.
use ironhorse_vm::{parse_symbols, Interp};

fn run(source: &str) -> String {
    let mut vm = Interp::new();
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let code = vm.relink_crank(&code, &parse_symbols(&symbols)).unwrap();
    let out = vm.run(&code);
    assert!(out.completed, "{:?}", out.halt);
    let (code, symbols) = ironhorse_compile::compile_atoms("trace.join()").unwrap();
    let code = vm.relink_crank(&code, &parse_symbols(&symbols)).unwrap();
    vm.run(&code).result
}

fn order_after(setup: &str) -> String {
    run(&[
        "var trace = []; var stack = new AsyncDisposableStack();",
        setup,
        "Promise.resolve().then(function () { return 0; })
           .then(function () { trace.push('job 1'); });
         stack.disposeAsync().then(function (v) { trace.push('dispose:' + v); });
         Promise.resolve().then(function () { return 0; })
           .then(function () { trace.push('job 2'); });",
    ]
    .join("\n"))
}

#[test]
fn null_resource_delays_settlement_one_turn() {
    assert_eq!(
        order_after("stack.use(null);"),
        "job 1,dispose:undefined,job 2"
    );
}

#[test]
fn undefined_resource_delays_settlement_one_turn() {
    assert_eq!(
        order_after("stack.use(undefined);"),
        "job 1,dispose:undefined,job 2"
    );
}

#[test]
fn empty_stack_settles_without_the_extra_turn() {
    assert_eq!(order_after(""), "dispose:undefined,job 1,job 2");
}

#[test]
fn null_use_returns_its_argument_and_skips_the_sync_stack() {
    assert_eq!(
        run("var trace = [];
             var a = new AsyncDisposableStack();
             var s = new DisposableStack();
             trace.push(a.use(null) === null, a.use(undefined) === undefined);
             trace.push(s.use(null) === null);
             s.dispose();
             trace.push(s.disposed);"),
        "true,true,true,true"
    );
}

#[test]
fn moved_stack_keeps_the_null_record() {
    assert_eq!(
        order_after("stack.use(null); stack = stack.move();"),
        "job 1,dispose:undefined,job 2"
    );
}

#[test]
fn null_record_beside_a_throwing_disposer_still_rejects() {
    assert_eq!(
        run("var trace = [];
             var stack = new AsyncDisposableStack();
             stack.defer(function () { throw 'boom'; });
             stack.use(null);
             stack.disposeAsync().then(
               function () { trace.push('fulfilled'); },
               function (e) { trace.push('rejected:' + e); });"),
        "rejected:boom"
    );
}
