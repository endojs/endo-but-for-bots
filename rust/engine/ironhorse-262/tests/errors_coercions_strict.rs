//! Regression gates for native errors, shared coercions, and strict failures.
//!
//! These programs are dual-run against the pinned XS oracle.  They deliberately
//! observe values through ordinary JavaScript rather than inspecting VM side
//! tables, so each test remains load-bearing for the guest-visible semantics.

use ironhorse_262::xst::{run_case, Config, Verdict};
use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?}; oracle={:?} ironhorse={:?})",
        run.ironhorse_halt,
        run.oracle_result,
        run.ironhorse_result,
    );
    assert!(
        run.result_agrees,
        "`{source}` result divergence: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

#[test]
fn native_errors_have_the_right_realm_surface() {
    for source in [
        "new Error('boom').message",
        "new TypeError('boom').name",
        "new TypeError('boom').constructor === TypeError",
        "new TypeError('boom') instanceof Error",
        "Error.length",
        "AggregateError.length",
        "new Error('boom', { cause: 17 }).cause",
        "var d = Object.getOwnPropertyDescriptor(new Error('boom', { cause: 17 }), 'cause'); d.value === 17 && d.writable && !d.enumerable && d.configurable",
        "new AggregateError([], 'boom', { cause: 23 }).cause",
        "!Object.prototype.hasOwnProperty.call(new Error('boom', Symbol('options')), 'cause')",
        "Function.prototype.call.bind(Object.prototype.hasOwnProperty)({ x: 1 }, 'x')",
        "Object.getOwnPropertyNames({ value: 1 })[0]",
        "Object.prototype.toString.call(new TypeError)",
        "Error.prototype.toString.call({ name: 'Custom', message: 12 })",
        "var e = new Error('boom'); e.name = 'Custom'; e.toString() === String(e)",
        "try { Error.prototype.toString.call(null); false } catch (e) { e instanceof TypeError }",
        "try { Error.prototype.toString.call({ name: Symbol() }); false } catch (e) { e instanceof TypeError }",
        "DataView.length",
        "Object.getOwnPropertyDescriptor(Array, 'prototype').writable === false",
        "Object.keys(Object.prototype).length === 0",
        "var e = new Error('boom'); var keys = []; for (var k in e) keys.push(k); keys.length === 0",
    ] {
        assert_result_agrees(source);
    }
}

#[test]
fn object_to_primitive_drives_string_and_numeric_operations() {
    for source in [
        "var o = { valueOf() { return 4; } }; o + 3",
        "var o = { toString() { return 'key'; } }; ({ key: 9 })[o]",
        "Number({ valueOf() { return '12'; } })",
        "String({ toString() { return 'ok'; } })",
        "var o = { valueOf() { return 1 }, toString() { return 'two' } }; String(o) + (o + 0)",
        "'10' < 9",
        "({ valueOf() { return 5 } }) < 6",
        "'3' & 1",
        "({ valueOf() { return 6 } }) | 1",
        "({ valueOf() { return 7 } }) * 2",
        "({ valueOf() { return 8 } }) - 3",
        "try { ({ valueOf() { throw 7; } }) + 1 } catch (e) { e }",
        "var n = new Number(1); n.valueOf = function () { return 42; }; n + 0",
    ] {
        assert_result_agrees(source);
    }
}

#[test]
fn strict_assignment_and_delete_throw_catchable_type_errors() {
    for source in [
        "'use strict'; try { Object.freeze({}).x = 1; false } catch (e) { e instanceof TypeError }",
        "'use strict'; var o = {}; Object.defineProperty(o, 'x', { value: 1, writable: true, enumerable: true, configurable: false }); try { delete o.x; false } catch (e) { e instanceof TypeError }",
        "'use strict'; (function () { return this === undefined; })()",
    ] {
        assert_result_agrees(source);
    }
}

#[test]
fn global_descriptor_environment_aliasing_is_an_honest_gap() {
    let run = dual_run(
        "Object.defineProperty(this, 'x', { configurable: true, value: 1 }); x",
    )
    .expect("the XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::OracleOnlyComplete);
    assert!(matches!(
        run.ironhorse_halt,
        ironhorse_vm::Halt::Unsupported("defineProperty:global-object")
    ));
}

#[test]
fn only_strict_test262_cases_execute_instead_of_preskipping() {
    let harness = std::env::temp_dir().join(format!(
        "ironhorse-errors-strict-harness-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&harness).expect("create temporary harness");
    std::fs::write(harness.join("sta.js"), "function Test262Error() {}\n").expect("write sta.js");
    std::fs::write(harness.join("assert.js"), "var assert = {};\n").expect("write assert.js");
    let source = r#"/*---
flags: [onlyStrict]
---*/
try { Object.freeze({}).x = 1; false }
catch (e) { e instanceof TypeError }
"#;
    let result = run_case(&Config::default(), &harness, source);
    assert_eq!(result.verdict, Verdict::Covered);
    assert!(!result.strict_skipped);
    std::fs::remove_dir_all(harness).expect("remove temporary harness");
}
