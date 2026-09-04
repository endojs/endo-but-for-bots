//! Fuzz target 3 (design § Fuzzability): differential source fuzzing over
//! the stage-2b grammar — objects, user-function calls, closures, and
//! thrown-and-caught exceptions. ironhorse and the XS oracle must agree
//! bit-for-bit on completion, result, and computrons; the 2b machinery is
//! metered faithfully, so this rides the full `differential_check`, not the
//! result-only variant the stage-2 allocating surface used.
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let program = ironhorse_fuzz::gen_stage2b_program(data);
    if let Err(divergence) = ironhorse_fuzz::differential_check(&program) {
        panic!("stage-2b differential divergence vs XS oracle: {:?}", divergence);
    }
});
