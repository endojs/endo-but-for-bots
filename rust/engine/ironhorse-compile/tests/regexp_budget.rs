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
