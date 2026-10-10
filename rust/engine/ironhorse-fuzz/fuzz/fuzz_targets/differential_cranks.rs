//! Fuzz target over the **multi-crank** differential (the wave-6 pattern-2
//! antidote, generalized).
//!
//! `dual_run_cranks` is the harness's only window onto cross-crank semantics
//! — state one crank creates and a later crank observes, on one live machine
//! per engine, with ironhorse relinking each crank's bytecode. The response
//! to the retrospective that identified the single-crank oracle as a
//! structural blind spot was a file of hand-written scenarios; this target
//! folds fuzzer bytes into a crank SEQUENCE so multi-crank coverage searches
//! the way the single-crank path already does.
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if let Err(divergence) = ironhorse_fuzz::crank_sequence_differential_is_clean(data) {
        panic!("multi-crank divergence vs XS oracle: {divergence:?}");
    }
});
