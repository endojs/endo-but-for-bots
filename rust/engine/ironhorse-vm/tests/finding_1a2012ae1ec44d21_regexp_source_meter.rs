//! Regression for continuous-Ironhorse-fuzz finding `1a2012ae1ec44d21`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 6-byte input
//! (sha256 `534cdfa51a6250b4e9026312f7143170cb8a8dae8b961912fb5017fb2bb16c49`)
//! folds, through `ironhorse_fuzz::gen_stage3b_regexp_program`, into the
//! program
//!
//! ```text
//! new RegExp("(?:0{1,3}\n{2})\S{1,3}(c|\1{1,3}\n{2})|(?:\1{1,3}\n{2})\S{1,3}(c|\2{1,3}.{1,3}){2}", "i").source
//! ```
//!
//! whose `.source` completion value is an unescaped 82-byte string. At the
//! finding SHA the differential arm gated on XS-computron equality and this
//! input reproduced a divergence (`computrons: oracle=36 ironhorse=37`): the
//! `.source` getter needs no escaping, so XS reuses the constructor's source
//! key while the pre-fix port charged a fresh string chunk — the result
//! agreed exactly, only the meter diverged. That is the same class as sibling
//! finding `1898f584e9bf841a`, resolved by its causal fix
//! `fix(ironhorse-vm): reuse unescaped regexp source` (the getter reuses the
//! constructor key when no escaping is required). The port was always correct
//! on the completion value.
//!
//! The load-bearing invariant this test locks is that the exact reproducing
//! input's generated program runs to completion **without panic** and yields
//! the byte-identical `.source` value. The raw computron count is
//! deliberately **not** pinned: the `differential_regexp_surface` harness now
//! treats XS-computron equality as advisory ("XS computron equality cannot
//! gate an IronHorse cost-table recalibration", `ironhorse-fuzz` §
//! `differential_check_meter_v4`), and the IronHorse cost table has since been
//! recalibrated for this program's constructs, so an exact-count assertion
//! would be brittle against ongoing recalibration rather than load-bearing.
//!
//! This submodule-free test keeps the exact input beside the deterministic
//! bytecode and symbols the oracle emits for its generated program and
//! replays them through `ironhorse_vm`.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-1a2012ae1ec44d21.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-1a2012ae1ec44d21.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-1a2012ae1ec44d21.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-1a2012ae1ec44d21.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_source_getter_completes_with_the_pinned_value() {
    assert_eq!(FINDING_INPUT.len(), 6, "the minimized input stays exact");

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.source program must complete without panic, got halt {:?}",
        output.halt
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the source getter must yield the byte-identical unescaped pattern"
    );
}
