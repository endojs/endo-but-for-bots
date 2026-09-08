use ironhorse_compile::{compile_atoms_with, compile_atoms_with_budget, ParseErrorKind};
use ironhorse_meter::{COMPILE_SOURCE_BYTE_METERING, COMPILE_WORK_METERING};

#[test]
fn using_disposal_slot_scans_are_precharged() {
    let n = 256u64;
    let declarations = (0..n)
        .map(|i| format!("using a{i}=null;"))
        .collect::<String>();
    let source = format!("function f() {{ {declarations} }}");
    let full = compile_atoms_with_budget(&source, false, u64::MAX);
    assert_eq!(
        full.result.unwrap(),
        compile_atoms_with(&source, false).unwrap()
    );
    assert!(full.parse_meter_raw >= 2 * n * n * COMPILE_WORK_METERING);
    let budget = n * n * COMPILE_WORK_METERING;
    let bounded = compile_atoms_with_budget(&source, false, budget);
    assert_eq!(bounded.result.unwrap_err().kind, ParseErrorKind::MeterLimit);
    assert_eq!(bounded.parse_meter_raw, budget);
}

#[test]
fn byte_admission_refuses_large_comments_before_compilation() {
    let source = format!("/*{}*/ 1", "x".repeat(1_000_000));
    let report = compile_atoms_with_budget(&source, false, 32 << 16);
    assert_eq!(report.result.unwrap_err().kind, ParseErrorKind::MeterLimit);
    assert_eq!(report.parse_meter_raw, 32 << 16);
}

#[test]
fn successful_budgeted_compilation_preserves_atoms_and_exact_boundary() {
    let source = "var a = [1, 2]; a[0] + a[1]";
    let report = compile_atoms_with_budget(source, false, u64::MAX);
    let raw = report.parse_meter_raw;
    assert!(raw > source.len() as u64 * COMPILE_SOURCE_BYTE_METERING);
    assert_eq!(
        report.result.unwrap(),
        compile_atoms_with(source, false).unwrap()
    );
    assert!(compile_atoms_with_budget(source, false, raw).result.is_ok());
    let short = compile_atoms_with_budget(source, false, raw - 1);
    assert_eq!(short.result.unwrap_err().kind, ParseErrorKind::MeterLimit);
    assert_eq!(short.parse_meter_raw, raw - 1);
}

#[test]
fn failures_retain_compilation_charges() {
    for source in ["var =", "'unterminated", r#"({"\uD800": })"#] {
        let report = compile_atoms_with_budget(source, false, u64::MAX);
        assert!(report.result.is_err());
        assert!(report.parse_meter_raw >= source.len() as u64 * COMPILE_SOURCE_BYTE_METERING);
    }
}

#[test]
fn tiny_budgets_and_large_single_tokens_are_named_refusals() {
    for source in [
        String::new(),
        " ".repeat(10_000),
        format!("'{}'", "x".repeat(10_000)),
    ] {
        let report = compile_atoms_with_budget(&source, false, 0);
        assert_eq!(report.result.unwrap_err().kind, ParseErrorKind::MeterLimit);
        assert_eq!(report.parse_meter_raw, 0);
    }
}

#[test]
fn work_limits_cover_bigint_and_regexp_validation() {
    let bigint = format!("{}n", "9".repeat(10_000));
    let regexp = format!(
        "/{}/",
        (0..1000).map(|i| format!("(?<a{i}>x)")).collect::<String>()
    );
    for source in [bigint, regexp] {
        let budget = (source.len() as u64 * 3) << 16;
        let report = compile_atoms_with_budget(&source, false, budget);
        assert_eq!(report.result.unwrap_err().kind, ParseErrorKind::MeterLimit);
        assert_eq!(report.parse_meter_raw, budget);
    }
}

#[test]
fn each_phase_boundary_refuses_without_panicking_or_emitting_partial_atoms() {
    for source in [
        "function f(x){try{return x+1;}finally{x=0;}} f(2)",
        "class C { x=1; static y=2; m(){return this.x;} } new C().m()",
        "class C { static #x=1; static #y=2; static get #z(){return this.#x;} }",
        "var a=[1,2]; var {x,...rest}={x:1,y:2}; for(var v of a) {x+=v;} x",
        "var x=12345678901234567890n; /(?<a>x)(?<b>y)/; x",
    ] {
        let full = compile_atoms_with_budget(source, false, u64::MAX);
        assert!(full.result.is_ok(), "{:?}", full.result);
        for units in 0..(full.parse_meter_raw >> 16) {
            let report = compile_atoms_with_budget(source, false, units << 16);
            assert_eq!(
                report.result.unwrap_err().kind,
                ParseErrorKind::MeterLimit,
                "{source}: {units}"
            );
            assert_eq!(report.parse_meter_raw, units << 16);
        }
    }
}

#[test]
fn embedding_host_retains_charges_across_a_compiler_unwind() {
    let meter = ironhorse_compile::ParseMeter::with_budget(u64::MAX);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ironhorse_compile::compile_atoms_with_meter(
            "class C { static { let x=1; } }",
            false,
            meter.clone(),
        )
    }));
    assert!(
        result.is_err(),
        "fixture reaches the existing named coder gap"
    );
    assert!(meter.raw() > 0);
    assert!(!meter.exhausted());
}

#[test]
fn regexp_string_set_products_are_bounded_without_named_captures() {
    let left = (0..1000)
        .map(|i| format!("aa{i}"))
        .collect::<Vec<_>>()
        .join("|");
    let right = (0..1000)
        .map(|i| format!("bb{i}"))
        .collect::<Vec<_>>()
        .join("|");
    let source = format!(r"/[\q{{{left}}}&&\q{{{right}}}]/v");
    let budget = (source.len() as u64 * 3) << 16;
    let report = compile_atoms_with_budget(&source, false, budget);
    assert_eq!(report.result.unwrap_err().kind, ParseErrorKind::MeterLimit);
    assert_eq!(report.parse_meter_raw, budget);
}

#[test]
fn live_host_refusal_interrupts_before_lexing_and_retains_the_charge() {
    let mut charged = 0;
    let meter = ironhorse_compile::ParseMeter::with_charge_callback(u64::MAX, |raw| {
        charged += raw;
        false
    });
    let progress = meter.clone();
    let source = "'unterminated";
    let result = ironhorse_compile::compile_atoms_with_meter(source, false, meter);
    assert_eq!(result.unwrap_err().kind, ParseErrorKind::MeterLimit);
    let raw = progress.raw();
    assert!(progress.exhausted());
    drop(progress);
    assert_eq!(charged, raw);
    assert_eq!(raw, source.len() as u64 * COMPILE_SOURCE_BYTE_METERING);
}

#[test]
fn live_callback_accounts_each_phase_and_stops_at_its_first_refusal() {
    let source = "function f(x){return x+1;} f(2)";
    let full = compile_atoms_with_budget(source, false, u64::MAX).parse_meter_raw;
    for limit in [(source.len() as u64 + 4) << 16, full - (1 << 16)] {
        let mut charged = 0;
        let mut refusals = 0;
        let meter = ironhorse_compile::ParseMeter::with_charge_callback(u64::MAX, |raw| {
            assert_eq!(refusals, 0, "no charge after refusal");
            charged += raw;
            let keep = charged <= limit;
            if !keep {
                refusals += 1;
            }
            keep
        });
        let progress = meter.clone();
        let result = ironhorse_compile::compile_atoms_with_meter(source, false, meter);
        assert_eq!(result.unwrap_err().kind, ParseErrorKind::MeterLimit);
        let raw = progress.raw();
        drop(progress);
        assert_eq!(charged, raw);
        assert_eq!(refusals, 1);
        assert!(raw > limit);
    }
}

#[test]
fn retained_meter_keeps_module_goal_and_bounds_its_compilation() {
    use ironhorse_compile::{
        compile_atoms_goal_with_meter, compile_module_atoms, Goal, ParseMeter,
    };
    let source = "export const x = 7; export function f(){return x;}";
    let meter = ParseMeter::with_budget(u64::MAX);
    let actual = compile_atoms_goal_with_meter(source, Goal::Module, false, meter.clone()).unwrap();
    assert_eq!(actual, compile_module_atoms(source).unwrap());
    let short = ParseMeter::with_budget(meter.raw() - 1);
    assert_eq!(
        compile_atoms_goal_with_meter(source, Goal::Module, false, short.clone())
            .unwrap_err()
            .kind,
        ParseErrorKind::MeterLimit
    );
    assert_eq!(short.raw(), meter.raw() - 1);
}
