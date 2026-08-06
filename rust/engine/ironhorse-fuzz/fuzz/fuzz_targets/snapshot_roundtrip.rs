//! Fuzz target (stage-6 child 4, design § Snapshots / Fuzzability): snapshot
//! round-trip invariance. Fuzzer bytes fold into an adversarially-shaped
//! machine image (a slot/chunk arena graph — closures, instances, bigints,
//! references, a free list, a value stack, and the symbol/key/name tables);
//! the image serialized with `write_machine`, read back with `read_machine`,
//! and re-serialized must be byte-identical, and the decoded image must equal
//! the original. Any divergence is a finding (the daemon's restore path relies
//! on this identity).
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if let Err(divergence) = ironhorse_fuzz::roundtrip_generated_is_invariant(data) {
        panic!("snapshot round-trip invariance divergence: {:?}", divergence);
    }
});
