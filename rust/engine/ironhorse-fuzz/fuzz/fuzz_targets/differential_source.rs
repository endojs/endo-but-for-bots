//! Fuzz target 1 (design § Fuzzability): differential source fuzzing.
//! A structure-aware generator turns fuzzer bytes into a subset-grammar
//! program; ironhorse and the XS oracle must agree bit-for-bit on
//! completion, result, and computrons.
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let program = ironhorse_fuzz::gen_program(data);
    if let Err(divergence) = ironhorse_fuzz::differential_check(&program) {
        panic!("differential divergence vs XS oracle: {:?}", divergence);
    }
});
