//! XS diagnostics for numeric and String built-ins remain catchable guest errors.
use ironhorse_262::{dual_run, Agreement};

#[test]
fn numeric_and_string_errors_match_xs_messages() {
    for (expression, expected) in [
        (
            "Number.prototype.toString.call({})",
            "TypeError: this: not a number",
        ),
        (
            "Number.prototype.toLocaleString.call(null)",
            "TypeError: this: not a number",
        ),
        ("(1).toString(2n)", "TypeError: cannot coerce to integer"),
        ("(1).toString(Object(2n))", "TypeError: cannot coerce to integer"),
        ("parseInt('10', Object(2n))", "TypeError: cannot coerce to integer"),
        ("isNaN(Object(1n))", "TypeError: cannot coerce to number"),
        ("String.fromCodePoint(Object(1n))", "TypeError: cannot coerce to number"),
        ("String.fromCharCode({valueOf(){return 1n}})", "TypeError: cannot coerce to number"),
        ("(1).toString(1)", "RangeError: invalid radix"),
        ("(1).toString(37)", "RangeError: invalid radix"),
        (
            "isNaN(Symbol())",
            "TypeError: cannot coerce symbol to number",
        ),
        ("isFinite(1n)", "TypeError: cannot coerce to number"),
        (
            "String.prototype.trim.call(undefined)",
            "TypeError: this: undefined",
        ),
        (
            "String.prototype.charAt.call(null)",
            "TypeError: this: null",
        ),
        (
            "''.concat(Symbol())",
            "TypeError: cannot coerce symbol to string",
        ),
        (
            "String.fromCharCode(Symbol())",
            "TypeError: cannot coerce symbol to number",
        ),
        (
            "String.fromCodePoint(1n)",
            "TypeError: cannot coerce to number",
        ),
        (
            "String.fromCodePoint(-1)",
            "RangeError: invalid code point -1.000000",
        ),
        (
            "String.fromCodePoint(1.5)",
            "RangeError: invalid code point 1.500000",
        ),
        (
            "String.fromCodePoint(1114112)",
            "RangeError: invalid code point 1114112.000000",
        ),
        (
            "String.fromCodePoint(NaN)",
            "RangeError: invalid code point nan",
        ),
        (
            "String.fromCodePoint(Infinity)",
            "RangeError: invalid code point inf",
        ),
        ("String.fromCodePoint(-Infinity)", "RangeError: invalid code point -inf"),
        ("String.fromCodePoint(1e308)", "RangeError: invalid code point 100000000000000001097906362944045541740492309677311846336810682903157585404911491537163328978494688899061249"),
        ("new String.fromCharCode(65)", "TypeError: new: not a constructor"),
        ("new String.raw()", "TypeError: new: not a constructor"),
        ("'x'.repeat(-1)", "RangeError: count < 0"),
        ("'x'.repeat(-Infinity)", "RangeError: count < 0"),
        ("'x'.repeat(Infinity)", "RangeError: count too big"),
        ("''.repeat(2147483648)", "RangeError: count too big"),
        ("'x'.normalize('invalid')", "RangeError: invalid form"),
        ("'x'.startsWith(/x/)", "TypeError: future editions"),
        ("'x'.endsWith(/x/)", "TypeError: future editions"),
        ("'x'.includes(/x/)", "TypeError: future editions"),
    ] {
        let run = dual_run(expression).expect("oracle starts");
        assert_eq!(run.agreement, Agreement::BothAbort, "{expression}: {run:?}");
        assert_eq!(run.oracle_error, expected, "XS diagnostic for {expression}");
        assert_eq!(
            run.ironhorse_error, expected,
            "Ironhorse diagnostic for {expression}"
        );
        let source = format!("try {{ {expression}; 'did not throw' }} catch (e) {{ String(e) }}");
        let caught = dual_run(&source).expect("oracle starts");
        assert_eq!(
            caught.agreement,
            Agreement::BothComplete,
            "{source}: {caught:?}"
        );
        assert_eq!(caught.oracle_result, expected, "{source}");
        assert_eq!(caught.ironhorse_result, expected, "{source}");
    }
}

#[test]
fn string_error_coercions_keep_guest_order_and_exceptions() {
    for source in [
        "var log=''; try { String.fromCodePoint({valueOf(){log+='a';return 65}}, {valueOf(){log+='b';return -1}}, {valueOf(){log+='c';return 66}}) } catch(e) { log+':'+String(e) }",
        "var log=''; try { String.prototype.repeat.call({toString(){log+='s';return 'x'}},{valueOf(){log+='n';return -1}}) } catch(e) { log+':'+String(e) }",
        "try { 'x'.normalize({toString(){throw 'guest form'}}) } catch(e) { String(e) }",
        "try { (1).toString({valueOf(){throw 'guest radix'}}) } catch(e) { String(e) }",
    ] {
        let run = dual_run(source).expect("oracle starts");
        assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
        assert!(run.result_agrees, "{source}: {run:?}");
    }
}

#[test]
fn padding_preserves_empty_filler_and_refuses_unbounded_allocation() {
    for source in [
        "'x'.padStart(Infinity, '')",
        "'x'.padEnd(1e100, '')",
        "var log=''; 'x'.padEnd(Infinity, {toString(){log+='f';return ''}}); log",
        "try { 'x'.padStart(Infinity, {toString(){throw 'filler'}}) } catch(e) {e}",
    ] {
        let run = dual_run(source).expect("oracle starts");
        assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
        assert!(run.result_agrees, "{source}: {run:?}");
    }
    let (code, symbols) = ironhorse_compile::compile_atoms(
        "try { 'x'.padEnd(Infinity, 'y') } catch(e) { 'incorrectly caught allocation refusal' }",
    )
    .unwrap();
    let mut machine = ironhorse_vm::Interp::new();
    machine.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
    let run = machine.run_bounded(&code, 1_000);
    assert_eq!(
        run.halt,
        ironhorse_vm::Halt::Refused("String.prototype.pad:result-too-large")
    );
    assert!(!run.completed);
}
