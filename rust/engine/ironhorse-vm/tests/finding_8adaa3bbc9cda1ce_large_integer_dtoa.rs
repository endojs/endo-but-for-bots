//! Regression for ironhorse fuzz finding `8adaa3bbc9cda1ce`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact minimized input `fc 03 bd` (sha256
//! `ae3640c01867b87df0ac9300ea7bc73ac273a010780e949beb393d945d0821bd`)
//! folds through the maintained differential-source grammar into a quotient
//! of products of `2113929216 / 1585446912` and `1585446912`. Its value is the
//! double `2513641910770335744`. XS renders that double as the non-shortest
//! `2513641910770335700`; ironhorse follows ECMA-262's shortest round-tripping
//! rule and renders the same double as `2513641910770336000`.
//!
//! The engines computed the same value, so this is the large-integer dtoa
//! spelling class again (compare `37e026fd30cbae19`). The divergence reproduced
//! only at the fuzzed project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`.
//! At the standing findings tip the differential harness compares finite
//! Number results by the oracle's exact double (`fdb9fef6e0`), so it no longer
//! reports a divergence. This submodule-free test replays the exact fuzz input
//! through a local copy of that input grammar, compiles the resulting program
//! with the pure-Rust compiler, and runs it through `ironhorse-vm`. It asserts
//! that the program completes without panic and returns the spec-conformant
//! result.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-8adaa3bbc9cda1ce.input.bin");
const FINDING_SOURCE: &str = "((((2113929216 / 1585446912) || (2113929216 / 1585446912)) * ((1585446912 * true) / (true || 1585446912))) / (((true || 1585446912) * (2113929216 / 1585446912)) / ((1585446912 * true) / (true || 1585446912))))";
const SHORTEST_RESULT: &str = "2513641910770336000";
/// XS's non-shortest rendering of the same double.
const XS_EXACT: &str = "2513641910770335700";

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
fn exact_fuzz_input_completes_without_panic_and_renders_shortest() {
    assert_eq!(FINDING_INPUT.len(), 3, "the minimized input remains exact");
    let source = generate_program(FINDING_INPUT);
    assert_eq!(
        source, FINDING_SOURCE,
        "the finding grammar must remain pinned"
    );

    let (bytecode, symbols) =
        ironhorse_compile::compile_atoms(&source).expect("finding source compiles");
    let outcome = ironhorse_vm::run_program_with_symbols(&bytecode, &symbols);

    assert!(
        outcome.completed,
        "finding program must complete without panic, got halt {:?}",
        outcome.halt
    );
    assert_eq!(outcome.result, SHORTEST_RESULT);
    assert_eq!(
        SHORTEST_RESULT.parse::<f64>().unwrap().to_bits(),
        XS_EXACT.parse::<f64>().unwrap().to_bits(),
        "the shortest and XS-exact spellings are the same IEEE-754 double",
    );
}
