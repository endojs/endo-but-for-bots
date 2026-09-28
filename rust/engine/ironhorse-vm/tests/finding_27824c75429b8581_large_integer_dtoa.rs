//! Regression for ironhorse fuzz finding `27824c75429b8581`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact minimized input (sha256
//! `7fe960a158191d9bbf71e234947f5d3854f846606e3b44edb3e800f8e408b5af`)
//! folds through the maintained differential-source grammar into
//! [`FINDING_SOURCE`]. Both engines compute the exactly representable double
//! `57983845202395136`. XS renders that value as the non-shortest exact
//! integer, while ironhorse uses the ECMA-262 shortest round-tripping decimal
//! `57983845202395140`, matching V8.
//!
//! The port was correct. The standing branch fixes the differential harness
//! by comparing a Number result with an independent spec spelling derived from
//! the oracle's exact double instead of requiring XS's decimal spelling. This
//! submodule-free test replays the exact fuzz input through a local copy of the
//! input grammar, compiles the resulting program with the pure-Rust compiler,
//! and runs it through `ironhorse-vm`.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-27824c75429b8581.input.bin");
const FINDING_SOURCE: &str = "(0 || (67108864 * ((0 && true) || (67108864 ^ 931135488))))";
const SHORTEST_RESULT: &str = "57983845202395140";
const XS_EXACT_RESULT: &str = "57983845202395136";

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
    assert_eq!(FINDING_INPUT.len(), 11, "the minimized input remains exact");
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
        "the shortest and XS-exact spellings are the same IEEE-754 double",
    );
}
