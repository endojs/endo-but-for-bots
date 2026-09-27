//! Regression for ironhorse fuzz finding `d87697d49a5f8f67`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The 7-byte minimized input
//! (sha256 `b4814c1b47ca2297e26e5e27a1151a79dc222cd408f51d4130a07d423229311b`)
//! folds, through `ironhorse_fuzz::gen_program`, into [`FINDING_PROGRAM`]: the
//! square of `1585446912`, the generator's `189 << 23` atom. The exact product
//! `2513641910770335744` is itself a double, and both engines compute it.
//!
//! The divergence was in the XS oracle's rendering, not the port. This is the
//! mirror of the `05264cccae42245a` tie class. The spacing between doubles
//! here is 512, and `2513641910770336000` lies exactly halfway between the
//! value and its upper neighbor `...336256`. The value's significand is even,
//! so round-half-even takes that tie back to the value itself. ECMA-262
//! §6.1.6.1.20 therefore admits the 16-digit spelling `2513641910770336000`,
//! and ironhorse and V8 both print it. XS's `fx_dtoa` excludes the even
//! boundary and prints the longer 17-digit `2513641910770335700`, which also
//! round-trips but is not the shortest.
//!
//! At the fuzzed SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb` the harness
//! compared the two spellings and reported a divergence. The standing branch
//! compares a Number completion against the oracle's exact double, so the
//! finding no longer reproduces. This test needs neither the XS oracle nor the
//! `c/moddable` submodule. It replays the exact input through a local copy of
//! the generator and pins the port's own evaluation and rendering.

mod common;

use common::TestCompiler;
use ironhorse_vm::value::number_to_ecma_string;
use ironhorse_vm::{parse_symbols, Interp};

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-d87697d49a5f8f67.input.bin");

/// `gen_program(FINDING_INPUT)`.
const FINDING_PROGRAM: &str = "((~(~(1585446912 / true))) * (~(~(1585446912 / true))))";

/// The double the finding program evaluates to on both engines.
const FINDING_VALUE: f64 = 2513641910770335744.0;
/// The spec-conformant (V8-matching) rendering: an even tie, 16 digits.
const SPEC: &str = "2513641910770336000";
/// XS's rendering: round-trips, but one digit longer than the shortest.
const XS_LONGER: &str = "2513641910770335700";

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
    assert_eq!(FINDING_INPUT.len(), 7, "the minimized input remains exact");
    assert_eq!(generate_program(FINDING_INPUT), FINDING_PROGRAM);
}

#[test]
fn finding_program_evaluates_and_renders_shortest_decimal() {
    let (code, symbols) = ironhorse_compile::compile_atoms(FINDING_PROGRAM).unwrap();
    let mut vm = Interp::new();
    vm.set_source_compiler(std::rc::Rc::new(TestCompiler));
    vm.link_intrinsics(&parse_symbols(&symbols));
    let outcome = vm.run(&code);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, SPEC);
}

#[test]
fn even_tie_spelling_round_trips_and_is_shortest() {
    assert_eq!(number_to_ecma_string(FINDING_VALUE), SPEC);
    // The 16-digit tie parses back to the value because its significand is even.
    assert_eq!(
        SPEC.parse::<f64>().unwrap().to_bits(),
        FINDING_VALUE.to_bits()
    );
    assert_eq!(FINDING_VALUE as u64 % 1024, 0, "the significand is even");
    // XS's 17-digit spelling denotes the same double but is not the shortest.
    assert_eq!(
        XS_LONGER.parse::<f64>().unwrap().to_bits(),
        FINDING_VALUE.to_bits()
    );
    assert_ne!(number_to_ecma_string(FINDING_VALUE), XS_LONGER);
}
