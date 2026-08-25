//! A function-valued program completion stringifies through
//! `Function.prototype.toString`. The pinned Moddable XS does NOT reproduce the
//! source text: every callable — a user function, an arrow, a class
//! constructor, a bound function, and a native prototype method — renders as the
//! synthesized host-function form `function ["<name>"] (){[native code]}`, its
//! own `.name` interpolated (empty for an anonymous function/arrow, `"bound "` +
//! target for a bound function). Before this coverage a function completion fell
//! to ironhorse's generic `[object Object]` reference stub, an honest
//! `non-primitive-completion` skip against the oracle's native-code form; the
//! render now closes that gap. This is a display-only rendering (no metering), so
//! the exact-metering corpus is untouched.

use ironhorse_262::{dual_run, Agreement};

fn assert_agree(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}");
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
    assert!(run.result_agrees, "results must agree for {source}");
}

#[test]
fn named_function_declaration_and_expression_completion() {
    assert_agree("function f(){}; f", "function [\"f\"] (){[native code]}");
    assert_agree(
        "(function named(){})",
        "function [\"named\"] (){[native code]}",
    );
}

#[test]
fn anonymous_arrow_completion() {
    // Nested arrow (`x => x => x`) completes with the outer arrow, anonymous.
    assert_agree("x => x => x", "function [\"\"] (){[native code]}");
    assert_agree("() => 1", "function [\"\"] (){[native code]}");
}

#[test]
fn class_constructor_completion() {
    // A class *expression* completes with its constructor, named by the class.
    assert_agree("(class C {})", "function [\"C\"] (){[native code]}");
    assert_agree(
        "var f = class C { $; }; f",
        "function [\"C\"] (){[native code]}",
    );
}

#[test]
fn bound_function_completion_carries_bound_name_prefix() {
    // `Function.prototype.bind` names the bound function `"bound " + target`.
    assert_agree(
        "function testFunc() {} testFunc.bind();",
        "function [\"bound testFunc\"] (){[native code]}",
    );
}

#[test]
fn bare_native_function_completion() {
    // A bare intrinsic (native, dispatched by `Native`) renders as the
    // host-function form under its own name — this path predates the fix and is
    // asserted here to guard the ordering of the render arms.
    assert_agree("Boolean", "function [\"Boolean\"] (){[native code]}");
}

#[test]
fn plain_object_completion_is_unchanged() {
    // The fix is scoped to callables; an ordinary object still renders through
    // `Object.prototype.toString` as the generic `[object Object]`, matching the
    // oracle.
    assert_agree("({ a: 1 })", "[object Object]");
    assert_agree("({ get a() {}, set a(x) {} })", "[object Object]");
}
