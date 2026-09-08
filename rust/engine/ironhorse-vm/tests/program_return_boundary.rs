//! A program-only RETURN must not certify an unfinished function activation
//! as a completed, persistable crank, whether entered inline or by a native.

use ironhorse_vm::opcode::{instruction_len, Opcode};
use ironhorse_vm::{parse_symbols, Halt, Interp, RunOutcome};

#[test]
fn program_return_refuses_live_function_frames() {
    for source in [
        "function f() { return 7; } f(); 99",
        "function f() { return 7; } [1].map(f); 99",
        "function f() { return 7; } new f(); 99",
    ] {
        let (mut code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
        let mut machine = Interp::new();
        machine.link_intrinsics(&parse_symbols(&symbols));
        let control = machine.run_bounded(&code, 10_000);
        assert_eq!(control.halt, Halt::Return, "{source}");
        assert_eq!(control.result, "99", "{source}");
        assert!(machine.is_quiescent(), "{source}");

        let mut pc = 0;
        while pc < code.len() && code[pc] != Opcode::XS_CODE_END as u8 {
            pc += instruction_len(&code, pc).expect("compiler emits valid instructions");
        }
        assert!(pc < code.len(), "fixture must contain f's END: {source}");
        code[pc] = Opcode::XS_CODE_RETURN as u8;

        let mut machine = Interp::new();
        machine.link_intrinsics(&parse_symbols(&symbols));
        let outcome = machine.run_bounded(&code, 10_000);
        assert_eq!(
            outcome.halt,
            Halt::EngineInvariant("return:non-program-frame"),
            "{source}"
        );
        assert!(!outcome.completed, "{source}");
        assert!(!machine.is_quiescent(), "{source}");
    }
}

fn next_crank(machine: &mut Interp, source: &str) -> RunOutcome {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let code = machine
        .relink_crank(&code, &parse_symbols(&symbols))
        .unwrap();
    machine.run(&code)
}

#[test]
fn a_new_crank_discards_abandoned_frames_but_preserves_captured_state() {
    for (first, second, expected) in [
        (
            "var saved; function f(){ let x=7; saved=()=>++x; throw 1; } f();",
            "saved()+','+saved()",
            "8,9",
        ),
        (
            "var x=2; var saved; with ({x:9}) { saved=function(){return x;}; throw 1; }",
            "x+','+saved()",
            "2,9",
        ),
    ] {
        let mut machine = Interp::new();
        let failed = next_crank(&mut machine, first);
        assert!(matches!(failed.halt, Halt::Throw { .. }), "{first}");
        assert!(
            !machine.is_quiescent(),
            "retain the halted state before reuse"
        );
        let recovered = next_crank(&mut machine, second);
        assert_eq!(recovered.halt, Halt::Return, "{second}");
        assert_eq!(recovered.result, expected, "{second}");
        assert!(machine.is_quiescent(), "{second}");
    }
}

#[test]
fn a_new_crank_discards_abandoned_operands_and_handlers() {
    let (code, symbols) = ironhorse_compile::compile_atoms(
        "var caught=0; try { 1 + (function(){ while(true){} })(); } catch(e) { caught=1; }",
    )
    .unwrap();
    let mut machine = Interp::new();
    machine.link_intrinsics(&parse_symbols(&symbols));
    let failed = machine.run_bounded(&code, 1_000);
    assert!(matches!(failed.halt, Halt::StepLimit(_)));
    assert!(!machine.is_quiescent());

    let recovered = next_crank(&mut machine, "caught+','+(this===globalThis)");
    assert_eq!(recovered.halt, Halt::Return);
    assert_eq!(recovered.result, "0,true");
    assert!(machine.is_quiescent());
}
