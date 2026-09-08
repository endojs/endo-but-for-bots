use ironhorse_compile::{compile_atoms_budgeted, CompileError, Goal};

#[test]
fn source_allocation_is_admitted_before_the_first_token() {
    for source in [
        format!("/*{}*/", "a".repeat(1_000_000)),
        format!("'{}'", "a".repeat(1_000_000)),
    ] {
        let mut charges = Vec::new();
        let result = compile_atoms_budgeted(&source, Goal::Eval, false, &mut |raw| {
            charges.push(raw);
            false
        });
        assert!(matches!(result, Err(CompileError::MeterAbort)));
        assert_eq!(
            charges,
            [source.len() as u64 * ironhorse_meter::COMPILE_SOURCE_BYTE_METERING]
        );
    }
}

#[test]
fn syntax_failures_keep_incurred_charges_and_budget_refusal_is_distinct() {
    let mut spent = 0;
    let result = compile_atoms_budgeted("var x = ;", Goal::Eval, false, &mut |raw| {
        spent += raw;
        true
    });
    assert!(matches!(result, Err(CompileError::Parse(_))));
    assert!(spent > ironhorse_meter::PARSE_TOKEN_METERING);
    let mut charges = 0;
    let result = compile_atoms_budgeted("var x = ;", Goal::Eval, false, &mut |_| {
        charges += 1;
        charges < 3
    });
    assert!(matches!(result, Err(CompileError::MeterAbort)));
    assert_eq!(charges, 3, "nothing runs after refusal");
}

#[test]
fn callback_panics_are_not_translated_into_budget_refusal() {
    let result = std::panic::catch_unwind(|| {
        compile_atoms_budgeted("1", Goal::Eval, false, &mut |_| {
            std::panic::panic_any(123_u32)
        })
    });
    assert_eq!(*result.err().unwrap().downcast::<u32>().unwrap(), 123);
}

#[test]
fn a_permissive_callback_can_grant_many_windows() {
    let source = format!("var x = 0; {} x", "x++;".repeat(1000));
    let mut consultations = 0;
    let compiled = compile_atoms_budgeted(&source, Goal::Eval, false, &mut |_| {
        consultations += 1;
        true
    })
    .unwrap();
    assert!(consultations > 1000);
    assert!(compiled.parse_computrons > 1000);
}
