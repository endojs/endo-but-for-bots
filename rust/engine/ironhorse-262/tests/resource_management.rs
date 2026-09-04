//! Focused differential regressions for explicit resource management.

use ironhorse_262::{dual_run, Agreement};

// FULL agreement — results AND computrons. The suite-wide gap this
// bar replaces (-4..-8 on the DisposableStack paths, -2 per sync
// `using`) decomposed into five measured per-operation constants
// (construct, add-record, use-record disposal, `using` declaration,
// `using` resource lookup), now charged at the natives; see
// `DISPOSABLE_STACK_CONSTRUCT_METERING` and siblings in the vm.
fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert!(run.is_bit_exact(), "{source}: {run:?}");
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
