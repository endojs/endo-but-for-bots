//! Fuzz target over the **store seam** (store-seam design § Fuzzability,
//! its phase-1 acceptance bar): `StoreManifest::decode`,
//! `SmallState::decode`, `validate_store`, and the adoption path
//! `import_from_container`.
//!
//! A daemon opens a database file it did not write, so every store row is
//! attacker-influenced bytes. Arbitrary and mutated-valid rows must yield a
//! structured `StoreError` — never a panic, a hang, or an unbounded
//! reservation — and an accepted row must have exactly one encoding.
//! The mutation arms are seeded from a real exported store so the corpus
//! starts inside the well-framed region.
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    // The arms report which of them the input reached; a target does not
    // act on that (a skipped input is not a trophy), but the deterministic
    // sweeps in `ironhorse_fuzz::store` assert floors on it, so a change
    // that stopped the arms reaching their subjects fails there.
    let _reached = ironhorse_fuzz::store_decoder_is_error_free(data);
    let _accepted = ironhorse_fuzz::store_succession_is_total(data);
    if let Err(detail) = ironhorse_fuzz::export_adopt_is_identity(data) {
        panic!("store export/adopt identity divergence: {detail}");
    }
});
