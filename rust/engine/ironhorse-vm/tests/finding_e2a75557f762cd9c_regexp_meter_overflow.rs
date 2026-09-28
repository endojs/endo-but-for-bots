//! Regression for Ironhorse fuzz finding `e2a75557f762cd9c`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 6-byte minimized input
//! (sha256 `85095187c6aeec9c687faa7157f09e51d8f91b247fde5a65bb1c84c1be31e512`)
//! folds through the maintained regexp generator into the adjacent 349-byte
//! nested-backreference pattern. Matching against a single space at offset
//! zero completes without a match after 84388 metered steps, for a raw 16.16
//! meter of `5_530_451_968`, which exceeds `u32::MAX`.
//!
//! At the finding SHA, the XS differential shim copied its 64-bit meter into
//! a 32-bit field and reported the wrapped value `1_235_484_672`. The existing
//! causal fix in `c8497fd88` widened the oracle fields to 64 bits; the port was
//! already correct. This test replays the exact input through a test-local copy
//! of the generator and pins the port's completion and full-width meter without
//! depending on the oracle or the `c/moddable` submodule.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-e2a75557f762cd9c.input.bin");
const EXPECTED_PATTERN: &str = include_str!("fixtures/finding-e2a75557f762cd9c.pattern.txt");
const EXPECTED_MATCH_METER_RAW: u64 = 5_530_451_968;
const OLD_ORACLE_WRAPPED_METER: u64 = 1_235_484_672;
const EXPECTED_CAPTURES: &[(i32, i32)] = &[
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
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (1, -1),
    (1, -1),
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
        6,
        "the minimized finding remains exact"
    );
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let (pattern, flags, subject, start) = generate_regexp(FINDING_INPUT);
    assert_eq!(pattern, EXPECTED_PATTERN);
    assert_eq!(flags, "");
    assert_eq!(subject, " ");
    assert_eq!(start, 0);

    let program = ironhorse_regexp::compile(&pattern, &flags).expect("finding pattern compiles");
    let outcome = ironhorse_regexp::match_regexp(&program, subject.as_bytes(), start);

    assert!(
        !outcome.matched,
        "the exact finding must remain a non-match"
    );
    assert!(!outcome.aborted, "matching must complete without aborting");
    assert!(
        !outcome.resource_limit,
        "matching must complete without a resource refusal"
    );
    assert_eq!(outcome.captures, EXPECTED_CAPTURES);
    assert_eq!(outcome.match_meter_raw, EXPECTED_MATCH_METER_RAW);
    assert_eq!(
        EXPECTED_MATCH_METER_RAW & u64::from(u32::MAX),
        OLD_ORACLE_WRAPPED_METER
    );
    assert_ne!(outcome.match_meter_raw, OLD_ORACLE_WRAPPED_METER);
}
