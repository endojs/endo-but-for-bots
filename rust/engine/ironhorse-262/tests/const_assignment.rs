//! Immutable lexical bindings throw catchable TypeErrors for both frame-local
//! and captured closure assignment opcodes.

fn assert_ironhorse_result(source: &str, expected: &str) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    let run = ironhorse_vm::run_program_with_symbols(&bytecode, &symbols);
    assert!(
        run.completed,
        "IronHorse completes {source:?}: {:?}",
        run.halt
    );
    assert_eq!(run.result, expected);
}

#[test]
fn direct_const_assignment_throws_without_mutating() {
    assert_ironhorse_result(
        "const x = 1; var caught = false; \
         try { x = 2; } catch (error) { caught = error instanceof TypeError; } \
         caught + ':' + x",
        "true:1",
    );
}

#[test]
fn captured_const_assignment_throws_without_mutating() {
    assert_ironhorse_result(
        "const x = 1; var caught = false; \
         try { (function () { x = 2; })(); } \
         catch (error) { caught = error instanceof TypeError; } \
         caught + ':' + x",
        "true:1",
    );
}
