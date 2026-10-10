use ironhorse_regexp::{
    compile, compile_checked, match_regexp_budgeted, CompileError, XS_PARSE_REGEXP_METERING,
    XS_REGEXP_METERING,
};

#[test]
fn folded_unicode_range_is_interruptible_and_merges_once() {
    let mut calls = 0;
    let limited = compile_checked(
        r"[\u{0}-\u{10ffff}]",
        "iu",
        u64::MAX,
        Some(&mut |_| {
            calls += 1;
            false
        }),
    );
    assert_eq!(limited.result.unwrap_err(), CompileError::BudgetExceeded);
    assert_eq!(calls, 1);
    let program = compile(r"[\u{0}-\u{10ffff}]", "iu").unwrap();
    assert!(program.code.len() < 10_000, "folded output stays compact");
    assert!(program.compile_meter_raw > 1_000_000 * XS_PARSE_REGEXP_METERING);
    for text in ["A", "a", "\u{212a}", "\u{10400}", "\u{10ffff}"] {
        assert!(ironhorse_regexp::match_regexp(&program, text.as_bytes(), 0).matched);
    }
}

#[test]
fn successful_and_syntax_failure_tails_are_charged() {
    for pattern in ["a", "("] {
        let mut charged = 0;
        let out = compile_checked(
            pattern,
            "",
            u64::MAX,
            Some(&mut |raw| {
                charged = raw;
                true
            }),
        );
        assert!(charged > 0);
        assert_eq!(charged, out.work_meter_raw);
        if let Ok(program) = out.result {
            assert_eq!(charged, program.compile_meter_raw);
        }
    }
}

#[test]
fn budgets_apply_without_a_callback() {
    assert_eq!(
        compile_checked("abc", "", 2, None).result.unwrap_err(),
        CompileError::BudgetExceeded
    );
    let program = compile("(a+)+b", "").unwrap();
    let out = match_regexp_budgeted(&program, b"aaaaaaaaaaaaaaaaaaaa", 0, 100, None);
    assert!(out.aborted && !out.matched && !out.resource_limit);
    assert_eq!(out.match_meter_raw, 100 * XS_REGEXP_METERING);
}

#[test]
fn cumulative_charset_payloads_have_a_storage_ceiling() {
    let mut pattern = String::from("[");
    for n in (0x1000..0x5000).step_by(2) {
        pattern.push_str(&format!("\\u{{{n:x}}}"));
    }
    pattern.push(']');
    assert_eq!(
        compile(&pattern, "u").unwrap_err(),
        CompileError::ResourceLimit
    );
}

#[test]
fn matcher_bounds_capture_snapshots_independently_of_work() {
    let pattern = format!("{}(a|aa)+b", "()".repeat(128));
    let program = compile(&pattern, "").unwrap();
    let subject = vec![b'a'; 100_000];
    let out = match_regexp_budgeted(&program, &subject, 0, 10_000_000, None);
    assert!(out.resource_limit, "{out:?}");
    assert!(!out.matched);
}

#[test]
fn compile_cost_table_version_two() {
    let cases = [
        ("abc", ""),
        (r"(?<word>ab)\k<word>", "u"),
        ("[A-Z]", "i"),
        (r"[\q{ab|ac|abc}]", "v"),
        ("(", ""),
    ];
    let actual: Vec<u64> = cases
        .into_iter()
        .map(|(p, f)| compile_checked(p, f, u64::MAX, None).work_meter_raw)
        .collect();
    assert_eq!(actual, vec![126_976, 204_800, 289_792, 355_328, 4_096]);
}
