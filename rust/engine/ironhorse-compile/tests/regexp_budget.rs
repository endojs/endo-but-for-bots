use ironhorse_compile::{compile_atoms_budgeted, CompileError, Goal};

#[test]
fn literals_share_the_source_compilation_budget() {
    let mut raw = 0;
    compile_atoms_budgeted("/a/", Goal::Eval, false, &mut |delta| {
        raw += delta;
        true
    })
    .unwrap();
    let mut spent = 0;
    let error = compile_atoms_budgeted("/a/; /a/", Goal::Eval, false, &mut |delta| {
        spent += delta;
        spent <= raw
    })
    .err()
    .expect("meter refusal");
    assert!(matches!(error, CompileError::MeterAbort));
}

#[test]
fn literal_host_refusal_is_distinct_from_syntax() {
    let error = compile_atoms_budgeted("/a/", Goal::Eval, false, &mut |_| false)
        .err()
        .expect("meter refusal");
    assert!(matches!(error, CompileError::MeterAbort));
}

#[test]
fn host_refusal_interrupts_regexp_inner_work() {
    let source = r"/[\u{0}-\u{10ffff}]/iu";
    let stride =
        ironhorse_regexp::COMPILE_CHECK_STRIDE * ironhorse_regexp::XS_PARSE_REGEXP_METERING;
    assert!((source.len() as u64) * ironhorse_meter::COMPILE_SOURCE_BYTE_METERING < stride);
    let mut refused = false;
    let result = compile_atoms_budgeted(source, Goal::Eval, false, &mut |delta| {
        assert!(!refused, "no callbacks after a refusal");
        if delta >= stride {
            refused = true;
            false
        } else {
            true
        }
    });
    assert!(refused, "reached regexp work beyond source/token admission");
    assert!(matches!(result, Err(CompileError::MeterAbort)));
}

#[test]
fn hard_allowance_caps_inner_regexp_receipt() {
    let source = r"/[\u{0}-\u{10ffff}]/iu";
    let source_raw = source.len() as u64 * ironhorse_meter::COMPILE_SOURCE_BYTE_METERING;
    let budget = source_raw + ironhorse_meter::PARSE_TOKEN_METERING * 4;
    let mut deltas = Vec::new();
    let result = ironhorse_compile::compile_atoms_budgeted_with_limit(
        source,
        Goal::Eval,
        false,
        budget,
        &mut |delta| {
            deltas.push(delta);
            true
        },
    );
    assert!(matches!(result, Err(CompileError::MeterAbort)));
    assert_eq!(deltas[0], source_raw);
    assert!(deltas.len() > 1, "source admission succeeded");
    assert_eq!(deltas.iter().sum::<u64>(), budget);
}

#[test]
fn invalid_literal_retains_regexp_residual_once() {
    let pattern = "(";
    let expected = ironhorse_regexp::compile_checked(pattern, "", u64::MAX, None);
    assert!(matches!(
        expected.result,
        Err(ironhorse_regexp::CompileError::Syntax(_))
    ));
    assert!(expected.work_meter_raw > 0);
    let mut lexer = ironhorse_compile::lexer::Lexer::new("/(/");
    lexer.next().unwrap();
    let before = lexer.meter().raw();
    let error = lexer.read_regexp(false).unwrap_err();
    assert_eq!(error.kind, ironhorse_compile::LexErrorKind::InvalidRegExp);
    assert_eq!(lexer.meter().raw() - before, expected.work_meter_raw);
}
