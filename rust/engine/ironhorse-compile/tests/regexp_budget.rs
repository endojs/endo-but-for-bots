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
