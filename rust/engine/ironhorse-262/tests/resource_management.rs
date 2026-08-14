//! Focused differential regressions for explicit resource management.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert!(run.result_agrees, "{source}: {run:?}");
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
