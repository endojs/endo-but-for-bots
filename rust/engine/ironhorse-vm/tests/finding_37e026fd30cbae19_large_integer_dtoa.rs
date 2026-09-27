//! Regression for ironhorse fuzz finding `37e026fd30cbae19`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact minimized input `1b 55 09` (sha256
//! `647d3c14b217f8fce6e2db6fc2ebd5f861669cbf3a48ca77a498505e7be15d36`)
//! folds through the maintained differential-source grammar into
//! `(((-(false * 226492416)) * (-(false * 226492416))) + (-((-226492416) *
//! (-226492416))))`. The left half is `(-0) * (-0)`, which is `+0`, so the
//! value is `-(226492416 * 226492416)`, the exactly representable double
//! `-51298814505517056` (`-729 * 2^46`). XS renders that double as the
//! non-shortest exact integer `-51298814505517056`; ironhorse follows
//! ECMA-262's shortest round-tripping rule and renders the same double as
//! `-51298814505517060`.
//!
//! The engines computed the same value, so this is the large-integer dtoa
//! spelling class again (compare `67a52af412f03a7b`, which is the positive
//! `(226492416 * 226492416)`). The divergence reproduced only at the fuzzed
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`. At the standing
//! findings tip the differential harness compares finite Number results by the
//! oracle's exact double (`fdb9fef6e0`), so it no longer reports a divergence.
//! This submodule-free test replays the exact fuzz input through a local copy of
//! that input grammar, compiles the resulting program with the pure-Rust
//! compiler, and runs it through `ironhorse-vm`. It asserts that the program
//! completes without panic and returns the spec-conformant result.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-37e026fd30cbae19.input.bin");
const FINDING_SOURCE: &str =
    "(((-(false * 226492416)) * (-(false * 226492416))) + (-((-226492416) * (-226492416))))";
const SHORTEST_RESULT: &str = "-51298814505517060";
/// XS's non-shortest exact-integer rendering of the same double.
const XS_EXACT: &str = "-51298814505517056";

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
