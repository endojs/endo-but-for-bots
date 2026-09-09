//! Ordinary indexed properties must participate in the native-reference gate.
use ironhorse_vm::opcode::{instruction_len, Opcode};
use ironhorse_vm::{parse_symbols, Interp};

fn stored_native(source: &str) -> Interp {
    let (mut code, symbols) = ironhorse_compile::compile_atoms(source).expect("compile");
    // COPY_OBJECT mints an internal native above the boot floor. Like FALSE,
    // it is one byte and pushes one value, so substitute at instruction
    // boundaries to retain it without adding a test-only allocation API.
    let mut pc = 0;
    let mut replaced = 0;
    while pc < code.len() {
        let len = instruction_len(&code, pc).expect("valid instruction");
        if code[pc] == Opcode::XS_CODE_FALSE as u8 {
            assert_eq!(len, 1);
            code[pc] = Opcode::XS_CODE_COPY_OBJECT as u8;
            replaced += 1;
        }
        pc += len;
    }
    assert_eq!(replaced, 1, "fixture must mint exactly one native");
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let outcome = vm.run_bounded(&code, 10_000);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert!(vm.is_quiescent());
    vm
}

#[test]
fn indexed_properties_refuse_non_persisted_natives() {
    assert_native_refused(false);
}

#[test]
fn checkpoint_indexed_properties_refuse_non_persisted_natives() {
    assert_native_refused(true);
}

fn assert_native_refused(checkpoint: bool) {
    for source in ["var box = [false]; 0;", "var box = {}; box[0] = false; 0;"] {
        let vm = stored_native(source);
        let refusal = Some("a stored reference to a non-persisted native function");
        let result = if checkpoint {
            vm.stored_unpersistable_row_at_checkpoint()
        } else {
            vm.stored_unpersistable_row()
        };
        assert_eq!(result, refusal, "{source}");
    }
}

#[test]
fn indexed_properties_allow_boot_and_guest_functions() {
    let (code, symbols) = ironhorse_compile::compile_atoms(
        "var box = {}; box[0] = Math.abs; box[1] = function () { return 7; }; 0;",
    )
    .expect("compile");
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let outcome = vm.run_bounded(&code, 10_000);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert!(vm.is_quiescent());
    assert!(vm
        .index_props_snapshot()
        .iter()
        .any(|(_, _, items)| items.len() == 2));
    assert_eq!(vm.stored_unpersistable_row(), None);
    assert_eq!(vm.stored_unpersistable_row_at_checkpoint(), None);
}
