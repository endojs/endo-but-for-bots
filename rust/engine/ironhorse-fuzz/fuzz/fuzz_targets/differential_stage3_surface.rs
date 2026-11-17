//! Fuzz target over the **stage-3 generator roster** (design § Fuzzability).
//!
//! The crate's structure-aware generators had oracle differential coverage
//! from fixed deterministic seed sweeps, but no coverage-guided mutation, no
//! persistent corpus and no nightly lane. A sweep finds what its seeds happen
//! to reach; this target searches.
//!
//! The first input byte selects a surface from `STAGE3_SURFACES`; the rest
//! drives that surface's generator, and the roster pairs each generator with
//! the differential check its surface admits.
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if let Err(divergence) = ironhorse_fuzz::stage3_surface_differential(data) {
        panic!(
            "stage-3 surface {} diverged from the XS oracle: {:?}",
            ironhorse_fuzz::stage3_surface_name(data),
            divergence
        );
    }
});
