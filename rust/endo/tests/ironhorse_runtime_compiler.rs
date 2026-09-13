//! F160: the production source compiler survives every machine lifecycle path.
#![cfg(feature = "ironhorse-engine")]

use endo::ironhorse_engine::engine::{
    CadencePolicy, HeapStoreOptions, Machine, MachineError, MeterBounds, PersistentMachine,
};

#[test]
fn ephemeral_eval_function_and_syntax_errors_use_the_runtime_compiler() {
    let machine = Machine::new();
    for (source, expected) in [
        ("eval('1+1')", "2"),
        ("Function('x', 'return x+3')(4)", "7"),
        ("eval(\"eval('2+3')\")", "5"),
        (
            "try { eval('var ='); } catch (e) { e.name; }",
            "SyntaxError",
        ),
        ("eval(\"'\\uD800'\").charCodeAt(0)", "55296"),
    ] {
        assert_eq!(machine.eval(source).unwrap(), expected, "{source}");
    }
}

#[test]
fn persistent_compiler_is_attached_at_boot_resume_and_rewind() {
    let dir = tempfile::tempdir().unwrap();
    let options = HeapStoreOptions {
        path: dir.path().join("runtime-compiler.sqlite"),
        signature: "runtime-compiler-test".to_string(),
        cadence: CadencePolicy::default(),
        meter: MeterBounds::per_crank(200_000),
        intrinsic_permit: None,
    };
    let mut machine = PersistentMachine::open(&options).unwrap();
    assert_eq!(
        machine.eval("var n = 10; eval('n += 1')").unwrap().result,
        "11"
    );
    machine.close().unwrap();

    let mut machine = PersistentMachine::open(&options).unwrap();
    assert_eq!(
        machine.eval("Function('return n + 1')()").unwrap().result,
        "12"
    );
    // Both the eval mutation and runaway execution are inside the same crank.
    assert!(matches!(
        machine.eval("eval('n = 99; while (true) {}')"),
        Err(MachineError::MeterAbort { .. })
    ));
    assert_eq!(machine.eval("eval('n')").unwrap().result, "11");
    assert_eq!(machine.eval("eval('n += 1')").unwrap().result, "12");
    machine.close().unwrap();
}

#[test]
fn ephemeral_dynamic_source_stays_under_the_crank_budget() {
    let machine = Machine::with_bounds(MeterBounds::per_crank(1000));
    // Source generation is cheap; compiling the generated text exceeds the
    // remaining budget. Catch must not intercept the resource stop.
    let outcome = machine
        .evaluate(
            "try { eval(' '.repeat(10000) + '1'); } catch (e) { 42; }",
            false,
        )
        .unwrap();
    assert!(!outcome.completed);
    assert!(matches!(outcome.halt, ironhorse_vm::Halt::MeterAbort));
}

#[test]
fn persistent_intrinsic_permit_survives_boot_resume_and_rewind() {
    let dir = tempfile::tempdir().unwrap();
    let mut options = HeapStoreOptions {
        path: dir.path().join("intrinsic-permit.sqlite"),
        signature: "intrinsic-permit-test".to_string(),
        cadence: CadencePolicy::default(),
        meter: MeterBounds::per_crank(200_000),
        intrinsic_permit: Some(vec!["JSON".to_string()]),
    };
    fn assert_denied(machine: &mut PersistentMachine, name: &str) {
        // The first crank interns the denied name through JSON's runtime key
        // path, before an identifier atom could mask a materialization leak.
        machine
            .eval(&format!("JSON.parse('{{\"{name}\":1}}'); 0"))
            .unwrap();
        assert_eq!(
            machine.eval(&format!("typeof {name}")).unwrap().result,
            "undefined"
        );
    }
    let mut machine = PersistentMachine::open(&options).unwrap();
    assert_denied(&mut machine, "eval");
    machine.close().unwrap();

    let mut machine = PersistentMachine::open(&options).unwrap();
    assert_denied(&mut machine, "Object");
    assert!(matches!(
        machine.eval("while (true) {}"),
        Err(MachineError::MeterAbort { .. })
    ));
    assert_denied(&mut machine, "Number");
    assert_eq!(machine.eval("typeof Function").unwrap().result, "undefined");
    machine.close().unwrap();

    // The supervisor explicitly chooses full binding authority on a later
    // open. Existing bindings and deletions are untouched; new names may bind.
    options.intrinsic_permit = None;
    let mut machine = PersistentMachine::open(&options).unwrap();
    assert_eq!(machine.eval("typeof Date").unwrap().result, "function");
    machine.close().unwrap();
}
