//! F077: guest Unicode at ASCII parser boundaries must never unwind Rust.
use ironhorse_vm::{parse_symbols, Interp};

#[test]
fn unicode_date_and_duration_inputs_are_rejected_without_panicking() {
    let source = r#"
        var count = 0;
        for (var scalar of ['é', '€', '😀', '\u0301', '\ud800', '\udfff']) {
            for (var text of ['a' + scalar + scalar, '+0000' + scalar,
                              '2020-01-01T00:00:00+a' + scalar + 'b',
                              '2020-01-01T00:00:00.' + scalar]) {
                if (!Number.isNaN(Date.parse(text))) throw new Error('accepted date');
                count++;
            }
            for (var text of ['P1' + scalar, 'PT1' + scalar, 'PT1.2' + scalar]) {
                try {
                    Temporal.Duration.from(text);
                    throw new Error('accepted duration');
                } catch (error) {
                    if (!(error instanceof RangeError)) throw error;
                    count++;
                }
            }
        }
        if (Date.parse('2020-01-01T00:00:00+0130') !== 1577831400000)
            throw new Error('valid zone');
        if (Temporal.Duration.from('PT1.25S').milliseconds !== 250)
            throw new Error('valid duration');
        count
    "#;
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let out = vm.run(&bytecode);
    assert!(out.completed, "{:?}", out.halt);
    assert_eq!(out.result, "42");
}

fn run(source: &str) -> String {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let out = vm.run(&bytecode);
    assert!(out.completed, "{source}: {:?}", out.halt);
    out.result
}

/// TemporalDurationToString sums the second and sub-second fields exactly and
/// carries them into whole seconds. Ironhorse multiplied the sub-second
/// fields in `u64`, which panicked the host on large fields (overflow checks
/// stay on in release builds), and never carried them into seconds.
#[test]
fn a_duration_renders_its_exact_seconds_without_panicking() {
    for (expression, expected) in [
        ("Temporal.Duration.from({ milliseconds: 2e13 })", "PT20000000000S"),
        ("new Temporal.Duration(0, 0, 0, 0, 0, 0, 0, 1500)", "PT1.5S"),
        (
            "new Temporal.Duration(0, 0, 0, 0, 0, 0, Number.MAX_SAFE_INTEGER, 0, 0, 999999999)",
            "PT9007199254740991.999999999S",
        ),
        (
            "new Temporal.Duration(0, 0, 0, 0, 0, 0, 0, Number.MAX_SAFE_INTEGER, 2000)",
            "PT9007199254740.993S",
        ),
        (
            "new Temporal.Duration(0, 0, 0, 0, 0, 0, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)",
            "PT9016206453995.731991S",
        ),
        (
            "new Temporal.Duration(0, 0, 0, 0, 0, 0, 0, -Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER)",
            "-PT9016215461194.986731991S",
        ),
        ("new Temporal.Duration()", "PT0S"),
        ("new Temporal.Duration(0, 0, 0, 1)", "P1D"),
        ("new Temporal.Duration(0, 0, 0, 0, 1)", "PT1H"),
        ("new Temporal.Duration(0, 0, 0, 0, 0, 1, 0, 1)", "PT1M0.001S"),
        ("new Temporal.Duration(-1, 0, 0, 0, 0, 0, 0, -1)", "-P1YT0.001S"),
        ("new Temporal.Duration(0, 0, 0, 0, 0, 0, 0, 0, 0, -1)", "-PT0.000000001S"),
    ] {
        assert_eq!(
            run(&format!("var d = {expression}; d.toString() + ' ' + d.toJSON()")),
            format!("{expected} {expected}"),
            "{expression}"
        );
    }
}

/// A balanced Duration stores each field as a Number, so a field past 2**53
/// is rounded before anything reads or renders it.
#[test]
fn a_balanced_duration_holds_float64_fields() {
    let source = r#"
        var z1 = new Temporal.ZonedDateTime(0n, "UTC");
        var z2 = new Temporal.ZonedDateTime(18446744073709551616n, "UTC");
        [z1.since(z2, { largestUnit: "microseconds" }), z1.until(z2, { largestUnit: "microseconds" })]
            .map(function (d) {
                return [d.microseconds === Math.sign(d.microseconds) * 18446744073709552,
                    d.toString(), Temporal.Duration.compare(d.add({ microseconds: 1 }), d)].join();
            }).join(' ')
    "#;
    assert_eq!(
        run(source),
        "true,-PT18446744073.709552616S,0 true,PT18446744073.709552616S,0"
    );
}
