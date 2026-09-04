//! Focused VM regressions for sloppy direct-eval closure environments.
//!
//! These bytecode-level probes isolate the contract between the coder's
//! `NEW_CLOSURE -> VAR_CLOSURE -> WITH -> STORE` prelude and the VM. The full
//! test262 differential slice exercises the same path through runtime eval
//! source compilation; keeping these small programs here makes a broken
//! shared-cell publication fail without first crossing that parser boundary.

use ironhorse_vm::{run_program, Halt, Interp, Opcode};

fn op(opcode: Opcode) -> u8 {
    opcode as u8
}

fn id(out: &mut Vec<u8>, opcode: Opcode, name: u16) {
    out.push(op(opcode));
    out.extend_from_slice(&name.to_le_bytes());
}

fn closure(out: &mut Vec<u8>, opcode: Opcode, index: u8) {
    out.extend_from_slice(&[op(opcode), index]);
}

fn begin(out: &mut Vec<u8>) {
    out.extend_from_slice(&[op(Opcode::XS_CODE_BEGIN_SLOPPY), 0]);
}

fn publish(out: &mut Vec<u8>, name: u16, value: i8, behavior: Opcode) {
    id(out, Opcode::XS_CODE_NEW_CLOSURE, name);
    out.extend_from_slice(&[op(Opcode::XS_CODE_INTEGER_1), value as u8]);
    closure(out, Opcode::XS_CODE_VAR_CLOSURE_1, 1);
    out.push(op(Opcode::XS_CODE_POP));
    out.push(op(behavior));
    out.push(op(Opcode::XS_CODE_WITH));
    closure(out, Opcode::XS_CODE_STORE_1, 1);
    out.push(op(Opcode::XS_CODE_POP));
}

fn read_result(out: &mut Vec<u8>, name: u16) {
    id(out, Opcode::XS_CODE_EVAL_REFERENCE, name);
    id(out, Opcode::XS_CODE_GET_VARIABLE, name);
    out.push(op(Opcode::XS_CODE_SET_RESULT));
}

#[test]
fn eval_declared_var_is_visible_through_the_published_cell() {
    let mut code = Vec::new();
    begin(&mut code);
    publish(&mut code, 1, 7, Opcode::XS_CODE_NULL);
    code.extend_from_slice(&[op(Opcode::XS_CODE_UNWIND_1), 1]);
    read_result(&mut code, 1);
    code.extend_from_slice(&[
        op(Opcode::XS_CODE_WITHOUT),
        op(Opcode::XS_CODE_END),
    ]);

    let run = run_program(&code);
    assert_eq!(run.halt, Halt::Return);
    assert_eq!(run.result, "7");
}

#[test]
fn eval_declared_function_value_is_visible_through_the_published_cell() {
    let mut code = Vec::new();
    begin(&mut code);
    // Model the hoisted `Define` initialization: put a real function value in
    // the closure cell before the null-behavior var environment publishes it.
    id(&mut code, Opcode::XS_CODE_NEW_CLOSURE, 2);
    id(&mut code, Opcode::XS_CODE_EVAL_REFERENCE, 1);
    id(&mut code, Opcode::XS_CODE_GET_VARIABLE, 1);
    closure(&mut code, Opcode::XS_CODE_VAR_CLOSURE_1, 1);
    code.push(op(Opcode::XS_CODE_POP));
    code.push(op(Opcode::XS_CODE_NULL));
    code.push(op(Opcode::XS_CODE_WITH));
    closure(&mut code, Opcode::XS_CODE_STORE_1, 1);
    code.push(op(Opcode::XS_CODE_POP));
    code.extend_from_slice(&[op(Opcode::XS_CODE_UNWIND_1), 1]);
    read_result(&mut code, 2);
    code.extend_from_slice(&[op(Opcode::XS_CODE_WITHOUT), op(Opcode::XS_CODE_END)]);

    let mut interp = Interp::new();
    interp.link_intrinsics(&["Boolean".to_string(), "declared".to_string()]);
    let run = interp.run(&code);
    assert_eq!(run.halt, Halt::Return);
    assert_eq!(run.result, "function [\"Boolean\"] (){[native code]}");
}

#[test]
fn eval_lexical_cell_preserves_tdz() {
    let mut code = Vec::new();
    begin(&mut code);
    id(&mut code, Opcode::XS_CODE_NEW_CLOSURE, 1);
    code.push(op(Opcode::XS_CODE_UNDEFINED));
    code.push(op(Opcode::XS_CODE_WITH));
    closure(&mut code, Opcode::XS_CODE_STORE_1, 1);
    code.push(op(Opcode::XS_CODE_POP));
    code.extend_from_slice(&[op(Opcode::XS_CODE_UNWIND_1), 1]);
    read_result(&mut code, 1);
    code.push(op(Opcode::XS_CODE_END));

    let run = run_program(&code);
    assert!(!run.completed);
    assert!(
        matches!(run.halt, Halt::Throw(ref error) if error.contains("ReferenceError")),
        "TDZ read must throw ReferenceError, got {:?}",
        run.halt
    );
}

#[test]
fn eval_published_const_rejects_assignment() {
    let mut code = Vec::new();
    begin(&mut code);
    id(&mut code, Opcode::XS_CODE_NEW_CLOSURE, 1);
    code.extend_from_slice(&[op(Opcode::XS_CODE_INTEGER_1), 4]);
    closure(&mut code, Opcode::XS_CODE_CONST_CLOSURE_1, 1);
    code.push(op(Opcode::XS_CODE_POP));
    code.push(op(Opcode::XS_CODE_UNDEFINED));
    code.push(op(Opcode::XS_CODE_WITH));
    closure(&mut code, Opcode::XS_CODE_STORE_1, 1);
    code.push(op(Opcode::XS_CODE_POP));
    id(&mut code, Opcode::XS_CODE_EVAL_REFERENCE, 1);
    code.extend_from_slice(&[op(Opcode::XS_CODE_INTEGER_1), 8]);
    id(&mut code, Opcode::XS_CODE_SET_VARIABLE, 1);
    code.push(op(Opcode::XS_CODE_END));

    let run = run_program(&code);
    assert!(!run.completed);
    assert!(
        matches!(run.halt, Halt::Throw(ref error) if error.contains("TypeError")),
        "const assignment must throw TypeError, got {:?}",
        run.halt
    );
}

#[test]
fn assignment_through_eval_reference_updates_the_shared_cell() {
    let mut code = Vec::new();
    begin(&mut code);
    publish(&mut code, 1, 3, Opcode::XS_CODE_NULL);
    id(&mut code, Opcode::XS_CODE_EVAL_REFERENCE, 1);
    code.extend_from_slice(&[op(Opcode::XS_CODE_INTEGER_1), 9]);
    id(&mut code, Opcode::XS_CODE_SET_VARIABLE, 1);
    code.push(op(Opcode::XS_CODE_POP));
    closure(&mut code, Opcode::XS_CODE_GET_CLOSURE_1, 1);
    code.push(op(Opcode::XS_CODE_SET_RESULT));
    code.extend_from_slice(&[
        op(Opcode::XS_CODE_WITHOUT),
        op(Opcode::XS_CODE_UNWIND_1),
        1,
        op(Opcode::XS_CODE_END),
    ]);

    let run = run_program(&code);
    assert_eq!(run.halt, Halt::Return);
    assert_eq!(run.result, "9");
}

#[test]
fn nested_eval_environments_shadow_then_reveal_the_outer_cell() {
    let mut code = Vec::new();
    begin(&mut code);
    publish(&mut code, 1, 1, Opcode::XS_CODE_NULL);
    id(&mut code, Opcode::XS_CODE_NEW_CLOSURE, 1);
    code.extend_from_slice(&[op(Opcode::XS_CODE_INTEGER_1), 2]);
    closure(&mut code, Opcode::XS_CODE_VAR_CLOSURE_1, 2);
    code.push(op(Opcode::XS_CODE_POP));
    code.push(op(Opcode::XS_CODE_UNDEFINED));
    code.push(op(Opcode::XS_CODE_WITH));
    closure(&mut code, Opcode::XS_CODE_STORE_1, 2);
    code.push(op(Opcode::XS_CODE_POP));
    read_result(&mut code, 1);
    code.push(op(Opcode::XS_CODE_WITHOUT));
    read_result(&mut code, 1);
    code.extend_from_slice(&[
        op(Opcode::XS_CODE_WITHOUT),
        op(Opcode::XS_CODE_UNWIND_1),
        2,
        op(Opcode::XS_CODE_END),
    ]);

    let run = run_program(&code);
    assert_eq!(run.halt, Halt::Return);
    assert_eq!(run.result, "1", "outer binding is visible after WITHOUT");
}
