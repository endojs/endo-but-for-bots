//! An exotic-builtin program completion stringifies through the same coercion
//! the pinned Moddable XS oracle performs, which ironhorse previously fell short
//! of — rendering its generic `[object Object]` reference stub (an honest
//! `non-primitive-completion` skip) or, for an `arguments` completion, the WRONG
//! `Array.prototype.join` of its indexed elements (`1,2`). This coverage closes
//! that gap for the builtin exotics whose `String()` is not `[object Object]`:
//!
//!   * an `ArrayBuffer`/`SharedArrayBuffer`/`DataView` inherits
//!     `Object.prototype.toString`, whose `Symbol.toStringTag` yields
//!     `[object ArrayBuffer]` / `[object SharedArrayBuffer]` / `[object DataView]`;
//!   * a TypedArray's `toString` IS `Array.prototype.toString`, so it renders the
//!     `join(",")` of its elements (`new Int8Array(3)` → `0,0,0`);
//!   * an `arguments` object's `Object.prototype.toString` builtinTag is
//!     `Arguments`, so it renders `[object Arguments]`, NOT the join of its
//!     indexed elements;
//!   * any object carrying a string `Symbol.toStringTag` on its own/inherited
//!     chain renders `[object <Tag>]`.
//!
//! This is a display-only rendering (no metering), so the exact-metering corpus
//! is untouched. Every expected string is the pinned oracle's own `String()` —
//! the dual run asserts ironhorse and the oracle agree.

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
fn array_buffer_completion_tag() {
    assert_agree("new ArrayBuffer(8)", "[object ArrayBuffer]");
    assert_agree("new ArrayBuffer()", "[object ArrayBuffer]");
}

#[test]
fn shared_array_buffer_completion_tag() {
    assert_agree("new SharedArrayBuffer(8)", "[object SharedArrayBuffer]");
}

#[test]
fn data_view_completion_tag() {
    assert_agree(
        "new DataView(new ArrayBuffer(8))",
        "[object DataView]",
    );
}

#[test]
fn typed_array_completion_joins_elements() {
    // A TypedArray stringifies through `Array.prototype.toString` → `join(",")`,
    // NOT its `[object …]` tag.
    assert_agree("new Int8Array(3)", "0,0,0");
    assert_agree("new Uint8Array(0)", "");
    assert_agree("var a = new Int16Array(3); a[0] = 7; a[2] = -9; a", "7,0,-9");
}

#[test]
fn bigint_typed_array_completion_joins_decimals() {
    // A BigInt64/BigUint64 element renders as its decimal (`String(0n)` → "0").
    assert_agree("new BigInt64Array(3)", "0,0,0");
    assert_agree("new BigUint64Array(2)", "0,0");
}

#[test]
fn arguments_completion_tag() {
    // The `arguments` exotic's `Object.prototype.toString` builtinTag is
    // `Arguments`; it does NOT join its indexed elements.
    assert_agree("(function(){ return arguments; })(1, 2)", "[object Arguments]");
    assert_agree("(function(){ 'use strict'; return arguments; })(1, 2)", "[object Arguments]");
    assert_agree("(function(){ return arguments; })()", "[object Arguments]");
}

#[test]
fn symbol_to_string_tag_completion() {
    // A guest object carrying a string `Symbol.toStringTag` (own or inherited)
    // renders `[object <Tag>]` through `Object.prototype.toString`.
    assert_agree(
        "({ [Symbol.toStringTag]: 'Widget' })",
        "[object Widget]",
    );
    assert_agree(
        "var p = { [Symbol.toStringTag]: 'Base' }; Object.create(p)",
        "[object Base]",
    );
}

#[test]
fn plain_object_completion_is_unchanged() {
    // The fix does not touch an ordinary object with no exotic identity and no
    // string `Symbol.toStringTag`: it still renders `[object Object]`.
    assert_agree("({ a: 1 })", "[object Object]");
    assert_agree("({ [Symbol.toStringTag]: 42 })", "[object Object]");
}
