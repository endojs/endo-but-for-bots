//! F071: hosts inspect decode categories and offsets without parsing strings.
use ironhorse_vm::{parse_symbols_checked, run_program_bounded, DecodeError, Halt, Opcode};

#[test]
fn instruction_errors_preserve_structured_context() {
    assert_eq!(
        run_program_bounded(&[], 10).halt,
        Halt::Decode(DecodeError::ProgramCounterOutOfBounds { pc: 0, len: 0 })
    );
    let invalid = (0..=u8::MAX)
        .find(|&b| Opcode::from_u8(b).is_none())
        .unwrap();
    assert_eq!(
        run_program_bounded(&[invalid], 10).halt,
        Halt::Decode(DecodeError::InvalidOpcode {
            pc: 0,
            byte: invalid
        })
    );
    let opcode = Opcode::XS_CODE_INTEGER_4 as u8;
    assert_eq!(
        run_program_bounded(&[opcode, 0], 10).halt,
        Halt::Decode(DecodeError::TruncatedInstruction {
            pc: 0,
            opcode,
            needed: 5,
            remaining: 2,
        })
    );
    let opcode = Opcode::XS_CODE_STRING_1 as u8;
    assert_eq!(
        run_program_bounded(&[opcode], 10).halt,
        Halt::Decode(DecodeError::UnresolvableInstructionLength { pc: 0, opcode })
    );
}

#[test]
fn catch_and_symbol_errors_have_distinct_categories() {
    assert_eq!(
        run_program_bounded(&[Opcode::XS_CODE_CATCH_1 as u8, 1], 10).halt,
        Halt::Decode(DecodeError::InvalidCatchTarget {
            pc: 0,
            target: 3,
            len: 2
        })
    );
    assert_eq!(
        parse_symbols_checked(&[2, 0, 0xff, 0]),
        Err(Halt::Decode(DecodeError::InvalidSymbols))
    );
}
