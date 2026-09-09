use ironhorse_regexp::{
    compile_checked, validate, validate_checked, CompileError, MAX_NESTING_DEPTH,
    XS_PARSE_REGEXP_METERING,
};

type Observed = (Result<(), CompileError>, u64, Vec<u64>);

fn observe(
    pattern: &str,
    flags: &str,
    budget: u64,
    refuse: Option<usize>,
    validation: bool,
) -> Observed {
    let mut callbacks = Vec::new();
    let mut check = |raw| {
        callbacks.push(raw);
        refuse != Some(callbacks.len())
    };
    let (result, raw) = if validation {
        let out = validate_checked(pattern, flags, budget, Some(&mut check));
        (out.result, out.work_meter_raw)
    } else {
        let out = compile_checked(pattern, flags, budget, Some(&mut check));
        (
            out.result
                .map(|program| assert_eq!(program.compile_meter_raw, out.work_meter_raw)),
            out.work_meter_raw,
        )
    };
    (result, raw, callbacks)
}

fn compare(pattern: &str, flags: &str, budget: u64, refuse: Option<usize>) -> Observed {
    let compiled = observe(pattern, flags, budget, refuse, false);
    let validated = observe(pattern, flags, budget, refuse, true);
    assert_eq!(
        validated, compiled,
        "pattern={pattern:?} flags={flags:?} budget={budget} refuse={refuse:?}"
    );
    validated
}

#[test]
fn syntax_verdicts_raw_totals_and_callbacks_match_compilation() {
    for (pattern, flags, valid) in [
        ("", "", true),
        ("abc", "", true),
        ("[A-Z]", "i", true),
        (r"(?<name>ab)\k<name>", "", true),
        (r"\k<later>(?<later>x)", "", true),
        (r"(?<name>a)|(?<name>b)", "u", true),
        (r"(?<name>a)(?<name>b)", "u", false),
        (r"\k<missing>(?<actual>x)", "", false),
        (r"(a)\2", "u", false),
        (r"(?<=ab)(c+?)(?!d)", "", true),
        (r"(?ims-s:a.[b-d])", "", false),
        (r"(?im-s:a.[b-d])", "", true),
        (r"[\q{ab|ac|abc}--\q{ac}]", "v", true),
        (r"[\p{ASCII}&&\p{Letter}]", "v", true),
        (r"[^\q{abc}]", "v", false),
        ("😀+", "u", true),
        ("😀+", "", true),
        (r"[\u{10400}-\u{10405}]", "iu", true),
        ("(", "", false),
        ("a{3,2}", "u", false),
        ("a", "gg", false),
        ("a", "uv", false),
        ("a", "z", false),
    ] {
        let out = compare(pattern, flags, u64::MAX, None);
        assert_eq!(out.0.is_ok(), valid, "{pattern:?}/{flags}");
        assert_eq!(validate(pattern, flags), out.0);
        assert_eq!(out.2.last().copied(), Some(out.1));
    }
}

#[test]
fn all_callback_cancellations_and_nearby_work_budgets_match() {
    for (pattern, flags) in [
        ("[a-z]".repeat(128), "i"),
        (r"(?<name>ab)\k<name>".to_owned(), ""),
        ("a|".repeat(512) + "b", ""),
        ("[a-z]".repeat(64) + "(", ""),
    ] {
        let full = compare(&pattern, flags, u64::MAX, None);
        for callback in 1..=full.2.len() {
            let rejected = compare(&pattern, flags, u64::MAX, Some(callback));
            assert_eq!(rejected.0, Err(CompileError::BudgetExceeded));
            assert_eq!(rejected.2, full.2[..callback]);
        }
        let units = full.1 / XS_PARSE_REGEXP_METERING;
        let mut budgets = vec![0, 1, units.saturating_sub(1), units, units + 1];
        for raw in &full.2 {
            let units = raw / XS_PARSE_REGEXP_METERING;
            budgets.extend([units.saturating_sub(1), units, units + 1]);
        }
        budgets.sort_unstable();
        budgets.dedup();
        for budget in budgets {
            let _ = compare(&pattern, flags, budget, None);
        }
    }
    // The final partial-stride callback can replace a syntax result.
    let rejected = compare("(", "", u64::MAX, Some(1));
    assert_eq!(rejected.0, Err(CompileError::BudgetExceeded));
    assert_eq!(rejected.1, 4096);
}

#[test]
fn validation_preserves_pattern_payload_and_nesting_limits() {
    let overlong = "a".repeat(ironhorse_regexp::compile::MAX_PATTERN_BYTES + 1);
    assert_eq!(
        compare(&overlong, "", u64::MAX, None).0,
        Err(CompileError::ResourceLimit)
    );
    let mut payload = String::from("[");
    for n in (0x1000..0x5000).step_by(2) {
        payload.push_str(&format!("\\u{{{n:x}}}"));
    }
    payload.push(']');
    assert_eq!(
        compare(&payload, "u", u64::MAX, None).0,
        Err(CompileError::ResourceLimit)
    );
    std::thread::Builder::new()
        .stack_size(32 * 1024 * 1024)
        .spawn(|| {
            for (open, close, flags) in [("(", ")", ""), ("(?<!", ")", ""), ("[", "]", "v")] {
                for depth in [MAX_NESTING_DEPTH, MAX_NESTING_DEPTH + 1] {
                    let pattern = format!(
                        "{}a{}",
                        open.repeat(depth as usize),
                        close.repeat(depth as usize)
                    );
                    let out = compare(&pattern, flags, u64::MAX, None);
                    assert_eq!(out.0.is_ok(), depth == MAX_NESTING_DEPTH);
                }
            }
        })
        .unwrap()
        .join()
        .expect("validation must return without overflowing");
}
