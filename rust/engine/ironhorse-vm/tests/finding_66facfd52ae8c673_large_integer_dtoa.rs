//! Regression for ironhorse fuzz finding `66facfd52ae8c673`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact 3-byte minimized input
//! (sha256 `01fcc1b6133deca5503a6e86aae129cfc07ba53bd053b2d5ab227fed2b51baa7`)
//! folds, through `ironhorse_fuzz::gen_program`, into arithmetic whose result is
//! the exactly representable double `51298825763029616`. XS's `fx_dtoa`
//! renders that exact integer, while ironhorse follows ECMA-262's shortest
//! round-tripping rule and renders the same double as `51298825763029620`.
//!
//! The engines therefore agree on the Number value and differ only in decimal
//! spelling. The differential harness fix from finding `d99d263fcf6ca7a7`
//! compares numeric completions by their `f64` value, so this same-class input
//! is not a divergence on the standing branch.
//!
//! This test replays the exact bytes through a local copy of the fuzz target's
//! small source generator, compiles with the pure-Rust compiler, and runs the
//! result in ironhorse-vm. It therefore needs neither the XS oracle nor the
//! `c/moddable` submodule.

use ironhorse_compile::compile_atoms;
use ironhorse_vm::run_program_with_symbols;

const INPUT: &[u8] = include_bytes!("fixtures/finding-66facfd52ae8c673.input.bin");
const SHORTEST_RESULT: &str = "51298825763029620";
const XS_EXACT_RESULT: &str = "51298825763029616";

struct FindingBytes<'a> {
    data: &'a [u8],
    position: usize,
}

impl<'a> FindingBytes<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, position: 0 }
    }

    fn next(&mut self) -> u8 {
        let byte = self.data[self.position % self.data.len()];
        self.position = self.position.wrapping_add(1);
        byte
    }

    fn choice(&mut self, count: u8) -> u8 {
        self.next() % count
    }
}

// Kept byte-for-byte equivalent in behavior to the small stage-1 generator in
// ironhorse-fuzz. Duplicating this test-only helper keeps the regression in the
// oracle-free ironhorse-vm test surface.
fn generate_program(data: &[u8]) -> String {
    let mut bytes = FindingBytes::new(data);
    generate_expression(&mut bytes, 4)
}

fn generate_expression(bytes: &mut FindingBytes<'_>, depth: u8) -> String {
    if depth == 0 {
        return generate_atom(bytes);
    }
    match bytes.choice(9) {
        0 => {
            let operator = ["+", "-", "*", "/", "%"][bytes.choice(5) as usize];
            format!(
                "({} {} {})",
                generate_expression(bytes, depth - 1),
                operator,
                generate_expression(bytes, depth - 1)
            )
        }
        1 => {
            let operator = ["&", "|", "^", "<<", ">>", ">>>"][bytes.choice(6) as usize];
            format!(
                "({} {} {})",
                generate_expression(bytes, depth - 1),
                operator,
                generate_expression(bytes, depth - 1)
            )
        }
        2 => {
            let operator =
                ["<", "<=", ">", ">=", "===", "!==", "==", "!="][bytes.choice(8) as usize];
            format!(
                "({} {} {})",
                generate_expression(bytes, depth - 1),
                operator,
                generate_expression(bytes, depth - 1)
            )
        }
        3 => {
            let operator = ["&&", "||"][bytes.choice(2) as usize];
            format!(
                "({} {} {})",
                generate_expression(bytes, depth - 1),
                operator,
                generate_expression(bytes, depth - 1)
            )
        }
        4 => format!("(-{})", generate_expression(bytes, depth - 1)),
        5 => format!("(!{})", generate_expression(bytes, depth - 1)),
        6 => format!("(~{})", generate_expression(bytes, depth - 1)),
        7 => format!(
            "({} ? {} : {})",
            generate_expression(bytes, depth - 1),
            generate_expression(bytes, depth - 1),
            generate_expression(bytes, depth - 1)
        ),
        _ => generate_atom(bytes),
    }
}

fn generate_atom(bytes: &mut FindingBytes<'_>) -> String {
    match bytes.choice(6) {
        0 => "true".to_string(),
        1 => "false".to_string(),
        2 => (bytes.next() as i32 - 128).to_string(),
        3 => ((bytes.next() as i64) << 23).to_string(),
        4 => {
            let whole = bytes.next() % 100;
            let fraction = bytes.next() % 100;
            format!("{}.{}", whole, fraction)
        }
        _ => (bytes.next() % 10).to_string(),
    }
}

#[test]
fn exact_fuzz_input_runs_without_panic_and_renders_shortest_decimal() {
    assert_eq!(
        INPUT.len(),
        3,
        "the minimized finding remains exactly three bytes"
    );

    let source = generate_program(INPUT);
    let (bytecode, symbols) = compile_atoms(&source).expect("finding source compiles");
    let outcome = run_program_with_symbols(&bytecode, &symbols);

    assert!(
        outcome.completed,
        "the exact finding must run to completion, got halt {:?}",
        outcome.halt
    );
    assert_eq!(
        outcome.result, SHORTEST_RESULT,
        "ironhorse must retain the spec-shortest decimal spelling"
    );
    assert_ne!(
        outcome.result, XS_EXACT_RESULT,
        "ironhorse must not adopt XS's non-shortest exact-integer spelling"
    );
    assert_eq!(
        SHORTEST_RESULT.parse::<f64>().unwrap().to_bits(),
        XS_EXACT_RESULT.parse::<f64>().unwrap().to_bits(),
        "the two spellings denote the same IEEE-754 Number"
    );
}
