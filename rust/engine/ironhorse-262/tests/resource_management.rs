//! Focused differential regressions for explicit resource management.

use ironhorse_262::{dual_run, dual_run_async, Agreement};

// Observable agreement — completion + result. The per-operation metering
// constants (`DISPOSABLE_STACK_CONSTRUCT_METERING` and siblings in the vm)
// were originally measured against XS during bring-up; they are now Iron
// Horse's own release costs, and computron drift against the oracle here is
// advisory only (XS-computron parity is a non-goal).
fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert!(run.observables_agree(), "{source}: {run:?}");
}

#[test]
fn disposable_stack_use_disposes_resource() {
    agrees(
        "var log = ''; var stack = new DisposableStack(); \
         stack.use({[Symbol.dispose]: function(){log += 'x'}}); stack.dispose(); log",
    );
}

#[test]
fn disposable_stack_defer_move_and_dispose() {
    agrees(
        "var log = ''; var first = new DisposableStack(); \
         first.defer(function(){log += 'a'}); first.defer(function(){log += 'b'}); \
         var second = first.move(); var moved = first.disposed; second.dispose(); \
         moved + ':' + second.disposed + ':' + log",
    );
}

#[test]
fn disposable_stack_adopt_passes_the_resource() {
    agrees(
        "var result; var stack = new DisposableStack(); \
         stack.adopt(42, function(value){result = value}); stack.dispose(); result",
    );
}

// ---- Wave-6 W6-5: the `using` DECLARATION surface --------------------
//
// The DisposableStack API above never exercises the `using` statement,
// whose dispatch arm gated BOTH @@dispose lookups behind the async
// opcode — so plain `using x = { [Symbol.dispose]() {} }` raised
// TypeError at the declaration for every non-nullish resource. XS
// disposes correctly; these are the differential locks the surface
// never had.

#[test]
fn sync_using_disposes_via_symbol_dispose() {
    agrees(
        "var log = ''; \
         { using x = { [Symbol.dispose]: function () { log += 'd'; } }; log += 'b'; } \
         log",
    );
}

#[test]
fn sync_using_disposes_in_reverse_declaration_order() {
    agrees(
        "var log = ''; \
         { using a = { [Symbol.dispose]: function () { log += 'a'; } }; \
           using b = { [Symbol.dispose]: function () { log += 'b'; } }; \
           log += '-'; } \
         log",
    );
}

#[test]
fn sync_using_skips_null_and_undefined_resources() {
    agrees(
        "var log = ''; \
         { using a = null; \
           using b = { [Symbol.dispose]: function () { log += 'd'; } }; \
           log += 'x'; } \
         log",
    );
}

/// Both engines complete `source` with the same observables, and the
/// completion value is `expected`.
fn completes_with(source: &str, expected: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert!(run.observables_agree(), "{source}: {run:?}");
    assert_eq!(run.ironhorse_result, expected, "{source}");
}

/// Both engines settle the global `g` to `expected` after the microtask drain.
fn settles_to(source: &str, expected: &str) {
    let run = dual_run_async(source, "g").expect("the XS oracle machine must start");
    assert_eq!(run.run.agreement, Agreement::BothComplete, "{:?}", run.run);
    assert_eq!(run.ironhorse_signal.as_deref(), Some(expected), "{source}");
}

#[test]
fn disposed_is_a_branded_prototype_accessor() {
    completes_with(
        "var sync = Object.getOwnPropertyDescriptor(DisposableStack.prototype, 'disposed'); \
         var async = Object.getOwnPropertyDescriptor(AsyncDisposableStack.prototype, 'disposed'); \
         var stack = new DisposableStack(); stack.dispose(); \
         var crossed; try { async.get.call(stack); crossed = 'no error'; } \
         catch (e) { crossed = e.constructor.name; } \
         [typeof sync.get, sync.get.name, sync.get.length, sync.set, sync.enumerable, \
          sync.configurable, sync.get.call(stack), crossed].join()",
        "function,get disposed,0,,false,true,true,TypeError",
    );
}

#[test]
fn disposed_reads_follow_a_redefined_accessor() {
    completes_with(
        "Object.defineProperty(DisposableStack.prototype, 'disposed', \
           { get() { return 'patched'; } }); \
         new DisposableStack().disposed",
        "patched",
    );
}

#[test]
fn iterator_dispose_calls_return_without_arguments() {
    completes_with(
        "var IteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())); \
         var seen = []; var iterator = Object.create(IteratorPrototype); \
         iterator.return = function () { seen.push(this === iterator, arguments.length); return {}; }; \
         var result = iterator[Symbol.dispose](); \
         var dispose = IteratorPrototype[Symbol.dispose]; \
         seen.concat([result, dispose.name, dispose.length]).join()",
        "true,0,,[Symbol.dispose],0",
    );
}

#[test]
fn iterator_dispose_discards_what_return_throws() {
    // The pinned XS closes with `fxIteratorReturn(the, mxThis, 1)`, the
    // abrupt-completion form, which drops an error thrown by `return` and
    // never checks its result.
    completes_with(
        "var IteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())); \
         var thrower = Object.create(IteratorPrototype); \
         thrower.return = function () { throw new Error('ignored'); }; \
         var primitive = Object.create(IteratorPrototype); \
         primitive.return = function () { return 1; }; \
         String(thrower[Symbol.dispose]()) + ':' + String(primitive[Symbol.dispose]())",
        "undefined:undefined",
    );
}

#[test]
fn async_iterator_dispose_resolves_through_return() {
    settles_to(
        "var g = ''; async function* generator() {} \
         var AsyncIteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf(generator.prototype)); \
         var iterator = Object.create(AsyncIteratorPrototype); var count = -1; \
         iterator.return = function () { count = arguments.length; return 7; }; \
         var bare = Object.create(AsyncIteratorPrototype); \
         Promise.all([iterator[Symbol.asyncDispose](), bare[Symbol.asyncDispose]()]).then( \
           function (values) { g = values.join() + ':' + count; }, \
           function (e) { g = 'E' + e; });",
        "7,:0",
    );
}

#[test]
fn async_iterator_dispose_rejects_instead_of_throwing() {
    settles_to(
        "var g = ''; async function* generator() {} \
         var AsyncIteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf(generator.prototype)); \
         var getter = { get return() { throw new RangeError('get'); } }; \
         var nullish = { return: null }; \
         var dispose = AsyncIteratorPrototype[Symbol.asyncDispose]; \
         var first = dispose.call(getter); var second = dispose.call(nullish); \
         Promise.allSettled([first, second]).then(function (results) { \
           g = results.map(function (r) { return r.status + ':' + r.reason.constructor.name; }).join(); \
         });",
        "rejected:RangeError,rejected:TypeError",
    );
}
