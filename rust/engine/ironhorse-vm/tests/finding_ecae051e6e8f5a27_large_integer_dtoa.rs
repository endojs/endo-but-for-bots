//! Regression for ironhorse fuzz finding `ecae051e6e8f5a27`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact minimized 10-byte input (sha256
//! `08008aee2c5d688bdab03d295c367c457bba1ed3706e802ff7ec2c6cd2e40c7d`)
//! folds through the maintained differential-source grammar into
//! [`FINDING_SOURCE`], a product of `922746880` and the negated sum
//! `377487360 + 922746880 / 17.5`. Its value is the double
//! `-396980243939421632`. Ironhorse follows ECMA-262's shortest
//! round-tripping rule (as V8 does) and renders it as `-396980243939421630`.
//! XS rendered `-396980243939421600`, which is not even the same double: it
//! rounds to a neighbor 64 below. The port is correct; the XS spelling is the
//! artifact.
//!
//! This is the large-integer dtoa spelling class again (compare
//! `aaa423e9c5d56067`). The divergence reproduced only at the fuzzed project
//! SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`. At the standing findings
//! tip the differential harness checks Number spelling against the spec, not
//! the oracle (`4b95dc199e`), so it no longer reports a divergence. This
//! submodule-free test replays the exact fuzz input through a local copy of
//! that input grammar, compiles the resulting program with the pure-Rust
//! compiler, and runs it through `ironhorse-vm`. It asserts that the program
//! completes without panic and returns the spec-conformant result.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-ecae051e6e8f5a27.input.bin");
const FINDING_SOURCE: &str = "(922746880 * (-(377487360 + (922746880 / 17.5))))";
const SHORTEST_RESULT: &str = "-396980243939421630";
/// The exact integer value of the result double.
const EXACT_VALUE: &str = "-396980243939421632";
/// XS's rendering, which names a different double.
const XS_SPELLING: &str = "-396980243939421600";

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
    assert_eq!(FINDING_INPUT.len(), 10, "the minimized input remains exact");
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
        EXACT_VALUE.parse::<f64>().unwrap().to_bits(),
        "the shortest spelling round-trips to the result double",
    );
    assert_ne!(
        XS_SPELLING.parse::<f64>().unwrap().to_bits(),
        EXACT_VALUE.parse::<f64>().unwrap().to_bits(),
        "the XS spelling names a different double",
    );
}
