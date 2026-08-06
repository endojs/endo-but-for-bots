//! Stage-5 compile-differential fuzz target (design § roadmap row 5,
//! Fuzzability): `ironhorse_compile::compile` vs the XS oracle compiler on
//! identical source — accept/reject agreement and, on a shared accept,
//! byte identity. An oracle process crash is a NAMED outcome
//! (`OracleUnavailable`), not a harness abort; a coder fold is
//! `IronhorseRejected`. A real `ByteDivergence` or an ironhorse-only accept
//! (`OracleRejected`) is the finding.
#![no_main]
use ironhorse_fuzz::CompileFuzzOutcome;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let program = ironhorse_fuzz::gen_compile_program(data);
    match ironhorse_fuzz::compile_differential_check(&program) {
        CompileFuzzOutcome::ByteDivergence { detail } => {
            panic!("compile byte divergence vs XS oracle on {program:?}: {detail}");
        }
        CompileFuzzOutcome::OracleRejected => {
            panic!("ironhorse compiled a program the XS oracle rejected: {program:?}");
        }
        // Identical / BothReject / IronhorseRejected (coder fold) /
        // OracleUnavailable are all valid, non-finding outcomes.
        _ => {}
    }
});
