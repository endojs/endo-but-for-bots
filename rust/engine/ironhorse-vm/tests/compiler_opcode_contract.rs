//! F147: check the generated compiler contract against the VM's live decoder.
use ironhorse_compile::opcodes;
use ironhorse_vm::opcode::{instruction_len, Opcode, CODE_SIZES, XS_CODE_COUNT};

#[path = "../../ironhorse-compile/tests/corpus_cases/mod.rs"]
mod corpus_cases;

#[test]
fn compiler_and_vm_opcode_names_ordinals_and_widths_agree() {
    assert_eq!(opcodes::XS_CODE_COUNT, XS_CODE_COUNT);
    assert_eq!(opcodes::ID_SIZE as usize, ironhorse_vm::opcode::ID_SIZE);
    assert_eq!(opcodes::CODE_SIZES, CODE_SIZES);
    for (id, name) in opcodes::OPCODE_NAMES.iter().enumerate() {
        let opcode = Opcode::from_u8(u8::try_from(id).unwrap()).unwrap();
        assert_eq!(*name, format!("{opcode:?}"));
        assert_eq!(opcode as usize, id);
    }
}

#[test]
fn every_compiled_corpus_program_has_complete_instruction_boundaries() {
    let programs = corpus_cases::corpus_programs();
    assert_eq!(programs.len(), corpus_cases::CORPUS_PROGRAM_COUNT);
    for (id, source) in programs {
        let code = ironhorse_compile::compile(&source)
            .unwrap_or_else(|error| panic!("{id}: compiler rejection: {error}"));
        let mut pc = 0;
        while pc < code.len() {
            pc += instruction_len(&code, pc)
                .unwrap_or_else(|| panic!("{id}: malformed instruction at {pc}"));
        }
        assert_eq!(pc, code.len(), "{id}");
    }
}
