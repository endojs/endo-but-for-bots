//! Fuzz target (stage-3b xsre, child 9/9): differential fuzzing of the
//! JavaScript RegExp **surface**. A structure-aware generator turns fuzzer
//! bytes into a whole-program `new RegExp(pat, flags).exec/test/…(subj)` over
//! the covered grammar; ironhorse-vm and the XS pin must agree bit-for-bit on the
//! completion value AND the computron count (the construction metering, the
//! `exec`/`test` result shaping, and the end-to-end calibration) — not just the
//! matcher, which the `differential_regexp` target already pins. Rides the
//! symbol-linking differential check (the surface resolves `exec`/`source`/
//! `index`/… by their program-local ids). An out-of-subset pattern the port
//! names `Unsupported` is skipped honestly, never reported as a divergence.
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let source = ironhorse_fuzz::gen_stage3b_regexp_program(data);
    if let Err(divergence) = ironhorse_fuzz::differential_check_with_symbols(&source) {
        panic!("regexp-surface differential divergence vs XS pin: {:?}", divergence);
    }
});
