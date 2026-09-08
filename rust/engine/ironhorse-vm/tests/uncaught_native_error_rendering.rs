use ironhorse_vm::{parse_symbols, Halt, Interp, Kind, RunOutcome};

fn run(source: &str) -> (Interp, RunOutcome) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut interp = Interp::new();
    interp.link_intrinsics(&parse_symbols(&symbols));
    let outcome = interp.run(&code);
    (interp, outcome)
}

#[test]
fn throwing_diagnostic_getter_preserves_original_value_and_cleans_callback_frames() {
    let (mut interp,out)=run("try {(0)()}catch(e){Object.defineProperty(e,'message',{get(){throw 'diagnostic failure'}});throw e}");
    assert!(!out.completed);
    assert!(!interp.is_quiescent());
    match out.halt {
        Halt::Throw { value, rendered } => {
            assert_eq!(
                value.kind,
                Kind::Reference,
                "original native error survives"
            );
            assert_eq!(rendered, "TypeError: call: not a function");
        }
        other => panic!("original throw changed: {other:?}"),
    }
    let (code, symbols) = ironhorse_compile::compile_atoms("40+2").unwrap();
    let code = interp
        .relink_crank(&code, &parse_symbols(&symbols))
        .unwrap();
    let next = interp.run(&code);
    assert!(next.completed);
    assert_eq!(next.result, "42");
    assert!(interp.is_quiescent());
}

#[test]
fn diagnostic_getter_execution_does_not_charge_the_guest_run() {
    let source = |count| {
        format!("try {{(0)()}}catch(e){{Object.defineProperty(e,'message',{{get(){{var i=0;while(i<{count})i++;return 'detail'}}}});throw e}}")
    };
    let (_, short) = run(&source(1));
    let (_, long) = run(&source(1000));
    assert_eq!(short.halt.thrown_rendering(), Some("TypeError: detail"));
    assert_eq!(long.halt.thrown_rendering(), short.halt.thrown_rendering());
    assert_eq!(
        long.computrons, short.computrons,
        "host rendering is unmetered"
    );
}
