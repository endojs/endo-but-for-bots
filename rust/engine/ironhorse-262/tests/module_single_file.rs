//! Single-file Module-goal execution: initialization and body functions run in
//! strict module mode while loader-dependent imports and top-level await remain
//! explicit boundaries.

use ironhorse_vm::{parse_symbols, Halt, Interp};

fn compile_module(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) =
        ironhorse_compile::compile_module_atoms(source).expect("module compiles");
    (bytecode, parse_symbols(&symbols))
}

fn read_global(machine: &mut Interp, name: &str) -> String {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(name).expect("reader compiles");
    let runnable = machine
        .relink_crank(&bytecode, &parse_symbols(&symbols))
        .expect("reader relinks");
    let outcome = machine.run(&runnable);
    assert!(outcome.completed, "reader completes: {:?}", outcome.halt);
    outcome.result
}

#[test]
fn module_body_is_strict_and_publishes_globals() {
    let (bytecode, symbols) = compile_module(
        "if (this !== undefined) throw new Error('module this'); globalThis.answer = 42;",
    );
    let mut machine = Interp::new();
    machine.link_intrinsics(&symbols);
    let outcome = machine.run(&bytecode);
    assert!(outcome.completed, "module completes: {:?}", outcome.halt);
    assert_eq!(read_global(&mut machine, "answer"), "42");
}

#[test]
fn local_and_exported_bindings_initialize_before_evaluation() {
    let (bytecode, symbols) = compile_module(
        "let x = 40; const y = 1; export const z = 1; globalThis.answer = x + y + z;",
    );
    let mut machine = Interp::new();
    machine.link_intrinsics(&symbols);
    let outcome = machine.run(&bytecode);
    assert!(outcome.completed, "module completes: {:?}", outcome.halt);
    assert_eq!(read_global(&mut machine, "answer"), "42");
}

#[test]
fn lexical_bindings_are_in_tdz_before_declaration_evaluation() {
    let (bytecode, symbols) = compile_module(
        "let caught = false; try { (function () { typeof x; })(); } \
         catch (error) { caught = error instanceof ReferenceError; } \
         let x; globalThis.answer = caught && x === undefined;",
    );
    let mut machine = Interp::new();
    machine.link_intrinsics(&symbols);
    let outcome = machine.run(&bytecode);
    assert!(outcome.completed, "module completes: {:?}", outcome.halt);
    assert_eq!(read_global(&mut machine, "answer"), "true");
}

#[test]
fn module_const_assignment_throws_a_catchable_type_error() {
    let (bytecode, symbols) = compile_module(
        "const x = 1; let caught = false; try { (function () { x = 2; })(); } \
         catch (error) { caught = error instanceof TypeError; } \
         globalThis.answer = caught && x === 1;",
    );
    let mut machine = Interp::new();
    machine.link_intrinsics(&symbols);
    let outcome = machine.run(&bytecode);
    assert!(outcome.completed, "module completes: {:?}", outcome.halt);
    assert_eq!(read_global(&mut machine, "answer"), "true");
}

#[test]
fn loader_dependent_module_shapes_stay_named() {
    let (bytecode, symbols) =
        compile_module("import { x } from './dep.js'; globalThis.answer = x;");
    let mut machine = Interp::new();
    machine.link_intrinsics(&symbols);
    assert_eq!(
        machine.run(&bytecode).halt,
        Halt::Unsupported("module:static-linking")
    );

    let (bytecode, symbols) = compile_module("await 1; globalThis.answer = 1;");
    let mut machine = Interp::new();
    machine.link_intrinsics(&symbols);
    assert_eq!(
        machine.run(&bytecode).halt,
        Halt::Unsupported("module:top-level-await")
    );
}
