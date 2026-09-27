//! Regression for ironhorse fuzz finding `931a687135cabb0c`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The 5-byte minimized input
//! (sha256 `dca671e311ff51c7e982a8778381d2a16c177906a0465b373d68f95977589a67`)
//! folds, through `ironhorse_fuzz::gen_program`, into [`FINDING_PROGRAM`]: the
//! square of `620757035`, where `310378496` is the generator's `37 << 23`
//! atom. The exact product `385339296501991225` rounds to the double
//! `385339296501991232`, and both engines compute that double.
//!
//! The divergence was in the XS oracle's rendering, not the port, as with
//! `05264cccae42245a`. XS's `fx_dtoa` printed `385339296501991200`, which lies
//! exactly halfway between the adjacent doubles `...168` and `...232` (the
//! spacing here is 64). Round-half-even takes it to `...168`, so it does not
//! round-trip. ECMA-262 §6.1.6.1.20 requires the shortest spelling that does,
//! `385339296501991230`, which is what ironhorse and V8 print.
//!
//! The differential harness already compares a Number completion against the
//! oracle's exact double, so the finding does not reproduce on this branch.
//! This test needs neither the XS oracle nor the `c/moddable` submodule. It
//! replays the exact input through a local copy of the generator and pins the
//! port's own evaluation and rendering.

mod common;

use common::TestCompiler;
use ironhorse_vm::value::number_to_ecma_string;
use ironhorse_vm::{parse_symbols, Interp};

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-931a687135cabb0c.input.bin");

/// `gen_program(FINDING_INPUT)`.
const FINDING_PROGRAM: &str =
    "((310378496 + (310378496 + (43 + false))) * (310378496 + (310378496 + (43 + false))))";

/// The double the finding program evaluates to on both engines.
const FINDING_VALUE: f64 = 385339296501991232.0;
/// The spec-conformant (V8-matching) rendering.
const SPEC: &str = "385339296501991230";
/// XS's rendering, a tie that parses back to the neighboring double.
const XS_TIE: &str = "385339296501991200";

struct InputBytes<'a> {
    data: &'a [u8],
    position: usize,
}

impl<'a> InputBytes<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, position: 0 }
    }

    fn next(&mut self) -> u8 {
        if self.data.is_empty() {
            return 0;
        }
        let byte = self.data[self.position % self.data.len()];
        self.position = self.position.wrapping_add(1);
        byte
    }

    fn choice(&mut self, options: u8) -> u8 {
        self.next() % options
    }
}

fn generate_program(data: &[u8]) -> String {
    let mut input = InputBytes::new(data);
    generate_expression(&mut input, 4)
}

fn generate_expression(input: &mut InputBytes<'_>, depth: u8) -> String {
    if depth == 0 {
        return generate_atom(input);
    }
    match input.choice(9) {
        0 => {
            let operator = ["+", "-", "*", "/", "%"][input.choice(5) as usize];
            format!(
                "({} {} {})",
                generate_expression(input, depth - 1),
                operator,
                generate_expression(input, depth - 1)
            )
        }
        1 => {
            let operator = ["&", "|", "^", "<<", ">>", ">>>"][input.choice(6) as usize];
            format!(
                "({} {} {})",
                generate_expression(input, depth - 1),
                operator,
                generate_expression(input, depth - 1)
            )
        }
        2 => {
            let operator =
                ["<", "<=", ">", ">=", "===", "!==", "==", "!="][input.choice(8) as usize];
            format!(
                "({} {} {})",
                generate_expression(input, depth - 1),
                operator,
                generate_expression(input, depth - 1)
            )
        }
        3 => {
            let operator = ["&&", "||"][input.choice(2) as usize];
            format!(
                "({} {} {})",
                generate_expression(input, depth - 1),
                operator,
                generate_expression(input, depth - 1)
            )
        }
        4 => format!("(-{})", generate_expression(input, depth - 1)),
        5 => format!("(!{})", generate_expression(input, depth - 1)),
        6 => format!("(~{})", generate_expression(input, depth - 1)),
        7 => format!(
            "({} ? {} : {})",
            generate_expression(input, depth - 1),
            generate_expression(input, depth - 1),
            generate_expression(input, depth - 1)
        ),
        _ => generate_atom(input),
    }
}

fn generate_atom(input: &mut InputBytes<'_>) -> String {
    match input.choice(6) {
        0 => "true".to_string(),
        1 => "false".to_string(),
        2 => (input.next() as i32 - 128).to_string(),
        3 => ((input.next() as i64) << 23).to_string(),
        4 => {
            let integer = input.next() % 100;
            let fraction = input.next() % 100;
            format!("{}.{}", integer, fraction)
        }
        _ => (input.next() % 10).to_string(),
    }
}

#[test]
fn exact_fuzz_input_generates_the_finding_program() {
    assert_eq!(FINDING_INPUT.len(), 5, "the minimized input remains exact");
    assert_eq!(generate_program(FINDING_INPUT), FINDING_PROGRAM);
}

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
    assert_eq!(tie, 385339296501991168.0);
    assert_ne!(tie.to_bits(), FINDING_VALUE.to_bits());
    assert_ne!(number_to_ecma_string(FINDING_VALUE), XS_TIE);
}
