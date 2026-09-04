//! Stage-5 parser fuzz target (design § roadmap row 5, Fuzzability): a
//! structure-aware program (or arbitrary bytes) driven through
//! `ironhorse_compile::Parser`, which must return a structured `Result` —
//! never a panic. libFuzzer treats any panic as the finding.
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    // Structure-aware generated program …
    let program = ironhorse_fuzz::gen_compile_program(data);
    let _ = ironhorse_fuzz::parse_is_panic_free(&program);
    // … and the raw bytes as (lossy) source, so ill-formed input is on the
    // fuzzed surface too. The parser must not panic on either.
    let raw = String::from_utf8_lossy(data);
    let _ = ironhorse_fuzz::parse_is_panic_free(&raw);
});
