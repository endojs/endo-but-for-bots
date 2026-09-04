//! Fuzz target (stage-6 child 4, design § Snapshots / Fuzzability): the
//! snapshot decoder. Arbitrary and mutated-valid bytes into `read_machine` /
//! `from_snapshot_bytes` must NEVER panic, hang, or allocate unboundedly —
//! every malformed input yields a structured `SnapshotError`. `forbid(
//! unsafe_code)` rules out a memory-safety hazard, but a panic (or an OOM from
//! a `Vec` pre-reserved by an untrusted count) in a read path is still a
//! defect: the daemon's restore path must fail closed, not crash the worker.
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    ironhorse_fuzz::decoder_is_error_free(data);
});
