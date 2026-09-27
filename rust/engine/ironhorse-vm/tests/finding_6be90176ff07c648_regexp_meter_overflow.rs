//! Regression for ironhorse fuzz finding `6be90176ff07c648`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 9-byte minimized input
//! (sha256 `241b6de8342803a0d585b1a517ecfefd09d78913f0770cd44ce8ef3fbdd4aa12`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a deeply nested alternation
//! of `{1,2}`/`{2}`-quantified groups over lazy `\Bb*\w*?`, `\S*\w` and
//! `\n\S*` runs, matched with flag `m` against `"\n  ab\n"` at offset zero.
//! Backtracking dispatches 152062 metered steps, so the raw 16.16 match meter
//! is `152062 * 65536 = 9965535232`, which exceeds `u32::MAX`.
//!
//! The port keeps that full value in a `u64`. At the finding SHA, the XS
//! differential oracle copied its own 64-bit meter into a 32-bit field and
//! wrapped it to `1375600640` (exactly `2^33` less), manufacturing a false
//! divergence. The causal oracle fix from finding `5d122a6fc10babd9` widened
//! the meter fields to 64 bits; the port was always correct.
//!
//! This test replays the exact bytes through a test-local copy of the maintained
//! regexp generator, then runs the resulting case through the pure-Rust regexp
//! engine. It therefore builds without the XS oracle or `c/moddable` submodule.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-6be90176ff07c648.input.bin");
const EXPECTED_MATCH_METER_RAW: u64 = 9_965_535_232;
const EXPECTED_CAPTURES: &[(i32, i32)] = &[
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (6, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
];

const ALPHABET: &[u8] = b"aabbc01 \n";

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

fn generate_regexp(data: &[u8]) -> (String, String, String, i32) {
    let mut input = InputBytes::new(data);
    let mut groups = 0;
    let pattern = generate_disjunction(&mut input, 3, &mut groups);
    let flags = match input.choice(5) {
        0 => "",
        1 => "m",
        2 => "s",
        3 => "i",
        _ => "",
    }
    .to_string();
    let subject_length = 1 + usize::from(input.next() % 8);
    let mut subject = String::new();
    for _ in 0..subject_length {
        subject.push(ALPHABET[usize::from(input.next()) % ALPHABET.len()] as char);
    }
    let start = if input.choice(4) == 0 {
        (usize::from(input.next()) % (subject.len() + 1)) as i32
    } else {
        0
    };
    (pattern, flags, subject, start)
}

fn generate_disjunction(input: &mut InputBytes<'_>, depth: u8, groups: &mut u32) -> String {
    let left = generate_sequence(input, depth, groups);
    if depth > 0 && input.choice(4) == 0 {
        format!(
            "{}|{}",
            left,
            generate_disjunction(input, depth - 1, groups)
        )
    } else {
        left
    }
}

fn generate_sequence(input: &mut InputBytes<'_>, depth: u8, groups: &mut u32) -> String {
    let count = 1 + input.choice(3);
    let mut output = String::new();
    for _ in 0..count {
        output.push_str(&generate_quantified(input, depth, groups));
    }
    output
}

fn generate_quantified(input: &mut InputBytes<'_>, depth: u8, groups: &mut u32) -> String {
    let (atom, is_group) = generate_atom(input, depth, groups);
    let quantifier = if is_group {
        match input.choice(5) {
            0 => "?",
            1 => "{2}",
            2 => "{1,2}",
            _ => "",
        }
    } else {
        match input.choice(8) {
            0 => "*",
            1 => "+",
            2 => "?",
            3 => "{2}",
            4 => "{1,3}",
            5 => "*?",
            6 => "+?",
            _ => "",
        }
    };
    format!("{atom}{quantifier}")
}

fn generate_atom(input: &mut InputBytes<'_>, depth: u8, groups: &mut u32) -> (String, bool) {
    match input.choice(if depth > 0 { 12 } else { 7 }) {
        0 | 1 => (generate_literal(input), false),
        2 => (generate_class(input), false),
        3 => (".".to_string(), false),
        4 => (
            match input.choice(6) {
                0 => "\\d",
                1 => "\\w",
                2 => "\\s",
                3 => "\\D",
                4 => "\\W",
                _ => "\\S",
            }
            .to_string(),
            false,
        ),
        5 => (
            match input.choice(4) {
                0 => "^",
                1 => "$",
                2 => "\\b",
                _ => "\\B",
            }
            .to_string(),
            false,
        ),
        6 => {
            if *groups > 0 {
                (
                    format!("\\{}", 1 + u32::from(input.next()) % *groups),
                    false,
                )
            } else {
                (generate_literal(input), false)
            }
        }
        7 => {
            *groups += 1;
            let inner = generate_disjunction(input, depth - 1, groups);
            (format!("({inner})"), true)
        }
        8 => {
            let inner = generate_disjunction(input, depth - 1, groups);
            (format!("(?:{inner})"), true)
        }
        9 => {
            let inner = generate_disjunction(input, depth - 1, groups);
            let polarity = if input.choice(2) == 0 { "=" } else { "!" };
            (format!("(?{polarity}{inner})"), true)
        }
        10 => {
            let inner = generate_disjunction(input, depth - 1, groups);
            let polarity = if input.choice(2) == 0 { "=" } else { "!" };
            (format!("(?<{polarity}{inner})"), true)
        }
        _ => (generate_literal(input), false),
    }
}

fn generate_literal(input: &mut InputBytes<'_>) -> String {
    match ALPHABET[usize::from(input.next()) % ALPHABET.len()] as char {
        '\n' => "\\n".to_string(),
        character => character.to_string(),
    }
}

fn generate_class(input: &mut InputBytes<'_>) -> String {
    let negation = if input.choice(3) == 0 { "^" } else { "" };
    match input.choice(4) {
        0 => format!("[{negation}a-c]"),
        1 => format!("[{negation}0-9]"),
        2 => format!("[{negation}abc]"),
        _ => format!("[{negation}a-c0-9]"),
    }
}

#[test]
fn exact_fuzz_input_preserves_the_full_width_match_meter() {
    assert_eq!(
        FINDING_INPUT.len(),
        9,
        "the minimized finding remains exact"
    );
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let (pattern, flags, subject, start) = generate_regexp(FINDING_INPUT);
    assert_eq!(flags, "m");
    assert_eq!(subject, "\n  ab\n");
    assert_eq!(start, 0);

    let program = ironhorse_regexp::compile(&pattern, &flags).expect("finding pattern compiles");
    let outcome = ironhorse_regexp::match_regexp(&program, subject.as_bytes(), start);

    assert!(!outcome.matched, "the exact finding pattern must not match");
    assert_eq!(
        outcome.captures, EXPECTED_CAPTURES,
        "the exact finding must retain its capture offsets"
    );
    assert_eq!(
        outcome.match_meter_raw, EXPECTED_MATCH_METER_RAW,
        "the exact finding must retain its full-width meter"
    );
    assert_ne!(
        outcome.match_meter_raw,
        EXPECTED_MATCH_METER_RAW & u64::from(u32::MAX),
        "the meter must not wrap to the old oracle's 32-bit value"
    );
}
