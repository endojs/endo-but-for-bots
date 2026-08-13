//! Oracle-backed regressions for UTF-16 String construction and prototype
//! algorithms. These deliberately include lone surrogates and generic
//! receivers so a UTF-8/scalar-value shortcut cannot satisfy the gate.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (halt: {:?})",
        run.ironhorse_halt,
    );
    assert!(
        run.result_agrees,
        "`{source}` diverged: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

#[test]
fn constructors_preserve_utf16_and_code_points() {
    for source in [
        "String.fromCharCode(65, 0xD800).charCodeAt(1)",
        "String.fromCharCode(0x10041)",
        "String.fromCodePoint(0x1F600).length",
        "String.fromCodePoint(0x1F600).codePointAt(0)",
        "String.fromCodePoint()",
    ] {
        agrees(source);
    }
}

#[test]
fn constructor_statics_reject_invalid_calls_catchably() {
    for source in [
        "try { String.fromCodePoint(Symbol()); false } catch (e) { e instanceof TypeError }",
        "try { String.fromCharCode(0n); false } catch (e) { e instanceof TypeError }",
        "try { new String.fromCharCode(65); false } catch (e) { e instanceof TypeError }",
        "try { String.fromCodePoint(0x110000); false } catch (e) { e instanceof RangeError }",
    ] {
        agrees(source);
    }
}

#[test]
fn padding_and_well_formedness_are_code_unit_exact() {
    for source in [
        "'x'.padStart(5, 'ab')",
        "'x'.padEnd(4)",
        "'abc'.padStart(2, 'z')",
        "'ok'.isWellFormed()",
        "String.fromCharCode(0xD800).isWellFormed()",
        "String.fromCharCode(0xD800).toWellFormed().charCodeAt(0)",
        "String.fromCodePoint(0x1F600).toWellFormed().length",
    ] {
        agrees(source);
    }
}

#[test]
fn methods_coerce_generic_receivers_and_trim_ecmascript_whitespace() {
    for source in [
        "String.prototype.trim.call(123)",
        "String.prototype.trim.call({ toString: function () { return '  ok  '; } })",
        "String.prototype.trim.call('\\u00A0\\uFEFFok\\u3000')",
        "String.prototype.padStart.call({ toString: function () { return 'x'; } }, 3, '0')",
    ] {
        agrees(source);
    }
}

#[test]
fn explicit_string_iterator_yields_unicode_code_points() {
    for source in [
        "var i='ab'[Symbol.iterator](); i.next().value+i.next().value+i.next().done",
        "var i=String.fromCodePoint(0x1F600)[Symbol.iterator](); i.next().value.length",
        "var i=String.fromCharCode(0xD800)[Symbol.iterator](); i.next().value.charCodeAt(0)",
    ] {
        agrees(source);
    }
}
