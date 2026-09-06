//! Member access and assignment on `null`/`undefined` throw the spec's
//! `TypeError` (architecture review F007).
//!
//! `GET_PROPERTY`'s receiver match fell through to `Slot::undefined()` for
//! a nullish base and `SET_PROPERTY` had no else arm, so `null.f`
//! evaluated to `undefined`, `null.f = 1` was a silent no-op, and every
//! `if (x.y)` guard over a nullish `x` took the wrong branch — a wrong
//! value, silently, from the most common runtime error in the language.
//! `null.f()` did throw, because the call site checks callability, which
//! masked the defect in the most-tested shape. XS's `fxToInstance` throws
//! `TypeError: cannot coerce null to object` / `… undefined to object`;
//! the messages below are the pinned oracle's `String(e)`.

use ironhorse_vm::{run_program_with_symbols, RunOutcome};

fn run(source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    run_program_with_symbols(&bytecode, &symbols)
}

fn assert_throws_type_error(source: &str, message: &str) {
    // `TypeError` is named so the realm links its prototype (as any program
    // that inspects the error does); `e.name`/`e.message` are the realm's
    // own view of the thrown object.
    let program = format!(
        "var r=0; try {{ {source} }} \
         catch(e){{ r=(e instanceof TypeError)+':'+e.name+': '+e.message }} r"
    );
    let out = run(&program);
    assert!(
        out.completed,
        "the TypeError must be catchable; halt: {:?}\n  {program}",
        out.halt
    );
    assert_eq!(out.result, format!("true:TypeError: {message}"), "{source}");
}

#[test]
fn reading_a_named_property_of_null_or_undefined_throws() {
    assert_throws_type_error("null.f", "cannot coerce null to object");
    assert_throws_type_error("undefined.f", "cannot coerce undefined to object");
    assert_throws_type_error("var a; a.f", "cannot coerce undefined to object");
    assert_throws_type_error("({}).x.y", "cannot coerce undefined to object");
}

#[test]
fn reading_a_computed_property_of_null_or_undefined_throws() {
    assert_throws_type_error("var k='f'; null[k]", "cannot coerce null to object");
    assert_throws_type_error("var k='f'; undefined[k]", "cannot coerce undefined to object");
    assert_throws_type_error("null[0]", "cannot coerce null to object");
}

#[test]
fn writing_a_property_of_null_or_undefined_throws() {
    assert_throws_type_error("null.f = 1", "cannot coerce null to object");
    assert_throws_type_error("undefined.f = 1", "cannot coerce undefined to object");
    assert_throws_type_error("var k='f'; null[k] = 1", "cannot coerce null to object");
    assert_throws_type_error("var k='f'; undefined[k] = 1", "cannot coerce undefined to object");
}

#[test]
fn the_other_nullish_coercions_carry_the_same_message() {
    // `TO_INSTANCE` (destructuring), `DELETE_PROPERTY(_AT)` and `IN` raised
    // a messageless TypeError; XS's texts, per the oracle.
    assert_throws_type_error("var {a} = null", "cannot coerce null to object");
    assert_throws_type_error("var {a} = undefined", "cannot coerce undefined to object");
    assert_throws_type_error("delete null.x", "cannot coerce null to object");
    assert_throws_type_error("var k='x'; delete undefined[k]", "cannot coerce undefined to object");
    assert_throws_type_error("'x' in null", "in: not an object");
    assert_throws_type_error("'x' in 5", "in: not an object");
}

#[test]
fn a_nullish_base_throws_before_the_computed_key_is_coerced() {
    // XS's `AT` coerces the base (`mxToInstance(mxStack + 1)`) before the
    // key: `k.toString` never runs for `null[k]`. For `null[k] = rhs` the
    // compiler's `at_2` follows the RHS, so the RHS runs, then the base
    // throws, and the key is still never coerced (oracle: `rhs,threw`).
    let out = run(
        "var s=[]; var k={toString(){s.push('key');return 'x'}}; \
         try{ null[k] }catch(e){ s.push(e.name+': '+e.message) } s.join('|')",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "TypeError: cannot coerce null to object");
    let out = run(
        "var log=[]; var k={toString(){ log.push('key'); return 'x' }}; \
         try { null[k] = (log.push('rhs'), 1) } catch(e){ log.push('threw') } log.join()",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "rhs,threw");
    let out = run(
        "var log=[]; var k={toString(){ log.push('key'); return 'x' }}; \
         try { null[k] += 1 } catch(e){ log.push('threw') } log.join()",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "threw");
    // An object base still coerces the key, after the RHS (oracle: `rhs,key`).
    let out = run(
        "var log=[]; var k={toString(){ log.push('key'); return 'x' }}; var o={}; \
         try { o[k] = (log.push('rhs'), 1) } catch(e){ log.push('threw') } log.join()",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "rhs,key");
}

#[test]
fn iterating_a_nullish_value_carries_the_coercion_message() {
    assert_throws_type_error("for (var x of null) {}", "cannot coerce null to object");
    assert_throws_type_error("[...undefined]", "cannot coerce undefined to object");
    // A non-nullish non-iterable reaches the absent method's call.
    assert_throws_type_error("for (var x of 5) {}", "call: not a function");
}

#[test]
fn a_nullish_guard_takes_the_throwing_path_not_the_wrong_branch() {
    // The silent form: before the fix `x.y` was `undefined` and the guard
    // fell through to "no".
    let out = run(
        "var x = null; var r = 'unset'; \
         try { if (x.y) { r = 'yes' } else { r = 'no' } } catch (e) { r = 'threw' } r",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "threw");
}

#[test]
fn an_uncaught_nullish_access_escapes_with_the_xs_rendering() {
    let out = run("null.f");
    assert!(!out.completed);
    assert_eq!(
        out.halt.thrown_rendering(),
        Some("TypeError: cannot coerce null to object")
    );
}

#[test]
fn optional_chaining_and_call_shapes_are_unchanged() {
    let out = run("var r=0; try { null?.f; r='ok' } catch(e) { r=String(e) } r");
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "ok");
    let out = run("var r=0; try { null.f() } catch(e) { r=e instanceof TypeError } r");
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "true");
}
