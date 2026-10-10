//! F162: malformed operands must not become guest-visible undefined values.
use ironhorse_vm::{Halt, Interp, Opcode};

#[test]
fn missing_operands_refuse_instead_of_executing_with_undefined() {
    // Independently stated operand requirements, spanning consuming and
    // non-consuming instructions and handlers factored out of the loop.
    for (opcode, operands, immediate) in [
        (Opcode::XS_CODE_POP, 1, 0),
        (Opcode::XS_CODE_SWAP, 2, 0),
        (Opcode::XS_CODE_AT, 2, 0),
        (Opcode::XS_CODE_AT_2, 3, 0),
        (Opcode::XS_CODE_CODE_1, 1, 1),
        (Opcode::XS_CODE_CODE_2, 1, 2),
        (Opcode::XS_CODE_CODE_4, 1, 4),
        (Opcode::XS_CODE_NAME, 1, 2),
        (Opcode::XS_CODE_ENVIRONMENT, 1, 0),
        (Opcode::XS_CODE_FUNCTION_ENVIRONMENT, 1, 0),
        (Opcode::XS_CODE_STORE_1, 1, 1),
        (Opcode::XS_CODE_STORE_2, 1, 2),
        (Opcode::XS_CODE_STORE_ARROW, 2, 0),
        (Opcode::XS_CODE_DUB, 1, 0),
        (Opcode::XS_CODE_SET_RESULT, 1, 0),
        (Opcode::XS_CODE_THROW, 1, 0),
        (Opcode::XS_CODE_VOID, 1, 0),
        (Opcode::XS_CODE_NOT, 1, 0),
        (Opcode::XS_CODE_PLUS, 1, 0),
        (Opcode::XS_CODE_MINUS, 1, 0),
        (Opcode::XS_CODE_BIT_NOT, 1, 0),
        (Opcode::XS_CODE_TO_NUMERIC, 1, 0),
        (Opcode::XS_CODE_ADD, 2, 0),
        (Opcode::XS_CODE_SUBTRACT, 2, 0),
        (Opcode::XS_CODE_MULTIPLY, 2, 0),
        (Opcode::XS_CODE_DIVIDE, 2, 0),
        (Opcode::XS_CODE_EXPONENTIATION, 2, 0),
        (Opcode::XS_CODE_EQUAL, 2, 0),
        (Opcode::XS_CODE_STRICT_EQUAL, 2, 0),
        (Opcode::XS_CODE_LESS, 2, 0),
        (Opcode::XS_CODE_IN, 2, 0),
        (Opcode::XS_CODE_INSTANCEOF, 2, 0),
        (Opcode::XS_CODE_GET_PROPERTY, 1, 2),
        (Opcode::XS_CODE_GET_PROPERTY_AT, 2, 0),
        (Opcode::XS_CODE_SET_PROPERTY, 2, 2),
        (Opcode::XS_CODE_SET_PROPERTY_AT, 3, 0),
        (Opcode::XS_CODE_DELETE_PROPERTY, 1, 2),
        (Opcode::XS_CODE_DELETE_PROPERTY_AT, 2, 0),
        (Opcode::XS_CODE_WITH, 1, 0),
        (Opcode::XS_CODE_SET_THIS, 1, 0),
    ] {
        for supplied in 0..operands {
            let mut code = vec![Opcode::XS_CODE_UNDEFINED as u8; supplied];
            code.push(opcode as u8);
            code.extend(std::iter::repeat_n(0, immediate));
            code.push(Opcode::XS_CODE_RETURN as u8);
            let mut vm = Interp::new();
            let out = vm.run_bounded(&code, 100);
            assert!(
                matches!(out.halt, Halt::EngineInvariant(_)),
                "{opcode:?} with {supplied} operands: {:?}",
                out.halt
            );
            assert!(!out.completed);
            assert!(out.halt.is_panic());
            assert!(!vm.is_quiescent());
        }
    }
}

#[test]
fn malformed_variadic_call_counts_are_engine_faults() {
    for prefix in [
        vec![],
        vec![Opcode::XS_CODE_UNDEFINED as u8],
        vec![Opcode::XS_CODE_INTEGER_1 as u8, 255],
    ] {
        let mut code = prefix;
        code.extend([Opcode::XS_CODE_RUN as u8, Opcode::XS_CODE_RETURN as u8]);
        let out = Interp::new().run_bounded(&code, 100);
        assert!(
            matches!(
                out.halt,
                Halt::EngineInvariant("value-stack:underflow" | "run:argument-count")
            ),
            "{:?}",
            out.halt
        );
    }
}

#[test]
fn an_explicit_undefined_operand_is_still_a_valid_thrown_value() {
    let out = Interp::new().run_bounded(
        &[Opcode::XS_CODE_UNDEFINED as u8, Opcode::XS_CODE_THROW as u8],
        100,
    );
    assert!(matches!(out.halt, Halt::Throw { .. }));
    assert_eq!(out.halt.thrown_rendering(), Some("undefined"));
}
