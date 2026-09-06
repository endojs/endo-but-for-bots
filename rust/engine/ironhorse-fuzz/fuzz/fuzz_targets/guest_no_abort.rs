//! Guest code halts the crank, never the process (design § Fuzzability, the
//! process-abort class): the only assertion is that the process is still
//! alive after an arbitrary structure-aware program has run — no native
//! stack overflow, no allocation abort, no panic. Every other target
//! compares answers; this one only checks that there is one.
//!
//! The program runs on a thread of the engine's documented stack size
//! (`ironhorse_vm::NATIVE_STACK_BYTES`), the size the native-recursion budget
//! is calibrated for, under a dispatch-count ceiling so a non-terminating
//! program is a bounded `Halt::StepLimit` rather than a libFuzzer timeout.
//! Generators are rotated by the leading byte so the recursion families —
//! callbacks and re-entrant built-ins, JSON, regexps, arbitrary text through
//! the compiler — are all on the fuzzed surface.
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Some((&selector, rest)) = data.split_first() else {
        return;
    };
    let source = match selector % 6 {
        0 => ironhorse_fuzz::gen_compile_program(rest),
        1 => ironhorse_fuzz::gen_json_parse_program(rest),
        2 => ironhorse_fuzz::gen_json_structured_program(rest),
        3 => ironhorse_fuzz::gen_stage3_reentrant_program(rest),
        4 => ironhorse_fuzz::gen_stage3b_regexp_program(rest),
        _ => String::from_utf8_lossy(rest).into_owned(),
    };
    let Ok((bytecode, symbols)) = ironhorse_compile::compile_atoms(&source) else {
        // A refusal is a structured outcome; only a crash is a finding.
        return;
    };
    let _outcome = std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(move || {
            let names = ironhorse_vm::parse_symbols(&symbols);
            let mut machine = ironhorse_vm::Interp::new();
            machine.link_intrinsics(&names);
            machine.run_bounded(&bytecode, ironhorse_fuzz::DECODER_STEP_LIMIT)
        })
        .expect("spawn the contract-stack thread")
        .join()
        .expect("a guest program must halt, never panic");
});
