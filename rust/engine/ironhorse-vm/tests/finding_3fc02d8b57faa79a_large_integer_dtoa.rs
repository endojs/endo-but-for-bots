//! Regression for ironhorse fuzz finding `3fc02d8b57faa79a`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact 4-byte minimized input (sha256
//! `b79d35f1bef51f37955b7b7b82e9cc54bc54739c5fc7faac9403dd96e9f95d55`)
//! folds through the maintained differential-source grammar into
//! `(981467136 * (981467136 ? (981467136 ? (-17 ? 58720256 : -17) :
//! (-17 * 58720256)) : 981467136))`. The truthy conditional arms reduce this
//! to `981467136 * 58720256`, the exactly representable double
//! `57632001481506816`.
//!
//! XS renders that double as the non-shortest exact integer
//! `57632001481506816`; ironhorse follows ECMA-262's shortest round-tripping
//! rule and renders the same Number as `57632001481506820`. The engines
//! computed the same value. The differential harness fix carries the oracle's
//! exact Number bits and compares IronHorse with an independently derived
//! ECMA-262 spelling, so this spelling difference is no longer a divergence.
//!
//! This submodule-free test replays the exact fuzz input through a local copy
//! of that input grammar, compiles the resulting program with the pure-Rust
//! compiler, and runs it through `ironhorse-vm`. It asserts completion without
//! panic and the spec-conformant result.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-3fc02d8b57faa79a.input.bin");
const FINDING_SOURCE: &str = "(981467136 * (981467136 ? (981467136 ? (-17 ? 58720256 : -17) : (-17 * 58720256)) : 981467136))";
const SHORTEST_RESULT: &str = "57632001481506820";
const XS_EXACT_RESULT: &str = "57632001481506816";

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
fn exact_fuzz_input_completes_and_renders_the_shortest_decimal() {
    assert_eq!(FINDING_INPUT.len(), 4, "the minimized input remains exact");
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
        XS_EXACT_RESULT.parse::<f64>().unwrap().to_bits(),
        "the shortest and XS-exact spellings denote the same IEEE-754 Number",
    );
}
