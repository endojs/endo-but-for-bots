//! Regression for ironhorse fuzz finding `fcbb16f5721e8fd2`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact 6-byte minimized input (sha256
//! `fad46ca0784d81a835adc494ab8451891bfb14000c497d7a9a7aa1c72ae0e13e`)
//! folds through the maintained differential-source grammar into
//! `(-(((true && -17) || (0.22 << 914358272)) * ((914358272 * 33554432) &&
//! (914358272 * 33554432))))`. The short-circuit arms reduce this to
//! `17 * 914358272 * 33554432`, the double `521573131844845568`.
//!
//! XS renders that double as the non-shortest `521573131844845570`; ironhorse
//! follows ECMA-262's shortest round-tripping rule (as V8 does) and renders
//! the same Number as `521573131844845600`. The engines computed the same
//! value. The differential harness compares Number completions by their
//! IEEE-754 bits, so this spelling difference is no longer a divergence.
//!
//! This submodule-free test replays the exact fuzz input through a local copy
//! of that input grammar, compiles the resulting program with the pure-Rust
//! compiler, and runs it through `ironhorse-vm`. It asserts completion without
//! panic and the spec-conformant result.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-fcbb16f5721e8fd2.input.bin");
const FINDING_SOURCE: &str = "(-(((true && -17) || (0.22 << 914358272)) * ((914358272 * 33554432) && (914358272 * 33554432))))";
const SHORTEST_RESULT: &str = "521573131844845600";
const XS_RESULT: &str = "521573131844845570";

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
    assert_eq!(FINDING_INPUT.len(), 6, "the minimized input remains exact");
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
        XS_RESULT.parse::<f64>().unwrap().to_bits(),
        "the shortest and XS spellings denote the same IEEE-754 Number",
    );
}
