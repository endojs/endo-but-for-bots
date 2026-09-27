//! Regression for ironhorse fuzz finding `05264cccae42245a`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The 3-byte minimized input `1b 64 1b`
//! (sha256 `fe91a16f9299c9c0d4dc9a35f1f1394d57adb1f9c4de97befb98afd383949f52`)
//! folds, through `ironhorse_fuzz::gen_program`, into [`FINDING_PROGRAM`].
//! Its shift counts are all multiples of 32 except the last (`226492443 & 31
//! = 27`), and both engines evaluate it to the same double,
//! `51298827675632344`.
//!
//! The divergence was in the XS oracle's rendering, not the port. XS's
//! `fx_dtoa` printed `51298827675632340`. That decimal lies exactly halfway
//! between the adjacent doubles `...336` and `...344` (the spacing here is 8).
//! Round-half-even takes it to `...336`, so it does not round-trip. ECMA-262
//! §6.1.6.1.20 requires `𝔽(s × 10^(n−k))` to be the value itself, so no
//! 16-digit spelling qualifies and the correct rendering is the 17-digit
//! `51298827675632344`. ironhorse and V8 both print that.
//!
//! The differential harness now compares a Number completion against the
//! oracle's exact double, which the XS shim reports alongside its string. It
//! no longer re-parses XS's spelling. This test needs neither the XS oracle
//! nor the `c/moddable` submodule. It pins the port's own evaluation and
//! rendering of the finding program.

mod common;

use common::TestCompiler;
use ironhorse_vm::value::number_to_ecma_string;
use ironhorse_vm::{parse_symbols, Interp};

/// `gen_program(&[0x1b, 0x64, 0x1b])`.
const FINDING_PROGRAM: &str = "((((226492416 + 27.27) << (838860800 << 226492416)) * ((226492416 + 27.27) << (838860800 << 226492416))) + (((27.27 * 27.27) + (838860800 << 226492416)) << ((226492416 + 27.27) << (838860800 << 226492416))))";

/// The double the finding program evaluates to on both engines.
const FINDING_VALUE: f64 = 51298827675632344.0;
/// The spec-conformant (V8-matching) rendering: all 17 digits are needed.
const SPEC: &str = "51298827675632344";
/// XS's rendering, a tie that parses back to the neighboring double.
const XS_TIE: &str = "51298827675632340";

#[test]
fn finding_program_evaluates_and_renders_round_tripping_decimal() {
    let (code, symbols) = ironhorse_compile::compile_atoms(FINDING_PROGRAM).unwrap();
    let mut vm = Interp::new();
    vm.set_source_compiler(std::rc::Rc::new(TestCompiler));
    vm.link_intrinsics(&parse_symbols(&symbols));
    let outcome = vm.run(&code);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, SPEC);
}

#[test]
fn tie_spelling_does_not_round_trip() {
    assert_eq!(number_to_ecma_string(FINDING_VALUE), SPEC);
    assert_eq!(
        SPEC.parse::<f64>().unwrap().to_bits(),
        FINDING_VALUE.to_bits()
    );
    // XS's spelling denotes a different double, so the port must not emit it.
    let tie = XS_TIE.parse::<f64>().unwrap();
    assert_eq!(tie, 51298827675632336.0);
    assert_ne!(tie.to_bits(), FINDING_VALUE.to_bits());
    assert_ne!(number_to_ecma_string(FINDING_VALUE), XS_TIE);
}
