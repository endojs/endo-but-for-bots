//! A golden digest of the compiler's observable output over generated
//! patterns: every group kind, alternations of duplicate names, modifier
//! groups, lookbehind spines, `v`-mode class expressions, nests across
//! [`MAX_NESTING_DEPTH`], and truncated or mangled variants of all of them.
//!
//! The digest covers what a caller of the compiler can observe: the code
//! words, the counts, the compile meter, the group names, the error and its
//! diagnostic context, the work charged, the meter-check callback values,
//! validation, and the outcome under several work budgets. The constant was
//! computed with the recursive compiler that preceded the iterative one
//! (STACK-DEPTH-REFACTOR.md §4.4 B7), so it pins byte-identical
//! compilation (the snapshot restore recompile depends on it) for as long as
//! the compiler, its meter and its error messages are meant to stay the
//! same. A deliberate change to any of them updates the constant.

use ironhorse_regexp::compile::{compile_units_checked, validate_units_checked};
use ironhorse_regexp::MAX_NESTING_DEPTH;

/// FNV-1a: a hash whose value is fixed by its definition, unlike
/// `DefaultHasher`.
struct Fnv(u64);

impl Fnv {
    fn bytes(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.0 ^= u64::from(byte);
            self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
        }
    }

    fn u64(&mut self, value: u64) {
        self.bytes(&value.to_le_bytes());
    }

    fn str(&mut self, value: &str) {
        self.u64(value.len() as u64);
        self.bytes(value.as_bytes());
    }
}

/// A fixed linear congruential generator, so the corpus is the same
/// everywhere.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) as u32
    }

    fn below(&mut self, n: usize) -> usize {
        self.next() as usize % n
    }

    fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len())]
    }
}

const ATOMS: &[&str] = &[
    "x",
    "y",
    ".",
    "\\w",
    "[a-c]",
    "[^b]",
    "^",
    "$",
    "\\b",
    "\\1",
    "\\2",
    "A",
    "k",
    "\u{212a}",
    "\u{1F600}",
    "\\u{1F600}",
];
const QUANTIFIERS: &[&str] = &["*", "+", "?", "{2}", "{1,3}?", "*?", "{2,}"];
const MODIFIERS: &[&str] = &["i", "m", "s", "i-s", "-i", "ms", "-m", "", "ii", "i-i"];
const NAMES: &[&str] = &["a", "b", "c"];

fn disjunction(r: &mut Lcg, depth: u32, out: &mut String) {
    let alternatives = [1, 1, 2, 2, 3, 4][r.below(6)];
    for alternative in 0..alternatives {
        if alternative > 0 {
            out.push('|');
        }
        for _ in 0..[0, 1, 1, 2, 3][r.below(5)] {
            if depth > 0 && r.chance(55) {
                group(r, depth - 1, out);
            } else if r.chance(10) {
                out.push_str("\\k<");
                out.push_str(r.pick(NAMES));
                out.push('>');
            } else {
                out.push_str(r.pick(ATOMS));
            }
            if r.chance(20) {
                out.push_str(r.pick(QUANTIFIERS));
            }
        }
    }
}

fn group(r: &mut Lcg, depth: u32, out: &mut String) {
    match r.below(10) {
        0..=2 => {
            out.push_str("(?<");
            out.push_str(r.pick(NAMES));
            out.push('>');
        }
        3 => out.push('('),
        4 => out.push_str("(?:"),
        5 => out.push_str("(?="),
        6 => out.push_str("(?!"),
        7 => out.push_str("(?<="),
        8 => out.push_str("(?<!"),
        _ => {
            out.push_str("(?");
            out.push_str(r.pick(MODIFIERS));
            out.push(':');
        }
    }
    disjunction(r, depth, out);
    out.push(')');
}

fn class(r: &mut Lcg, depth: u32, out: &mut String) {
    out.push('[');
    if r.chance(20) {
        out.push('^');
    }
    let operands = 1 + r.below(3);
    let operator = r.pick(&["", "", "--", "&&", "-"]);
    for operand in 0..operands {
        if operand > 0 {
            out.push_str(operator);
        }
        if depth > 0 && r.chance(60) {
            class(r, depth - 1, out);
        } else {
            out.push_str(r.pick(&[
                "a",
                "b",
                "z",
                "\\w",
                "\\d",
                "\\q{ab|c|}",
                "\\q{}",
                "\\p{L}",
                "a-c",
                "b-a",
                "\\-",
                "&",
                "-",
                "",
            ]));
        }
    }
    out.push(']');
}

fn mangle(r: &mut Lcg, pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let at = r.below(chars.len() + 1);
    let (head, tail) = chars.split_at(at);
    let head: String = head.iter().collect();
    let tail: String = tail.iter().collect();
    match r.below(5) {
        0 => head,
        1 => format!(
            "{head}{}{tail}",
            r.pick(&["(", ")", "|", "[", "]", "*", "(?<a>", "(?i:"])
        ),
        2 => format!("{head}{}", tail.chars().skip(1).collect::<String>()),
        3 => format!("{pattern})"),
        _ => format!("({pattern}"),
    }
}

fn corpus() -> Vec<(String, &'static str)> {
    let mut r = Lcg(0x5e_ed_b7);
    let mut corpus = Vec::new();
    for _ in 0..1500 {
        let mut pattern = String::new();
        let depth = 1 + r.below(5) as u32;
        disjunction(&mut r, depth, &mut pattern);
        let flags = r.pick(&["", "u", "i", "v", "iu", "s"]);
        corpus.push((mangle(&mut r, &pattern), flags));
        corpus.push((pattern, flags));
    }
    for _ in 0..800 {
        let mut pattern = String::new();
        let depth = 1 + r.below(5) as u32;
        class(&mut r, depth, &mut pattern);
        let flags = r.pick(&["v", "vi"]);
        corpus.push((mangle(&mut r, &pattern), flags));
        corpus.push((pattern, flags));
    }
    let limit = MAX_NESTING_DEPTH as usize;
    for depth in [limit - 1, limit, limit + 1] {
        for (open, close) in [
            ("(", ")"),
            ("(?:", ")*"),
            ("(?<=", ")"),
            ("(?!", ")"),
            ("(?i:", ")"),
            ("(b|", ")"),
        ] {
            let pattern = format!("{}a{}", open.repeat(depth), close.repeat(depth));
            for flags in ["", "u", "v"] {
                corpus.push((pattern[..pattern.len() - 1].to_string(), flags));
                corpus.push((pattern.clone(), flags));
            }
        }
        corpus.push((
            format!(
                "(?<n>{}a{})\\k<n>",
                "(".repeat(depth - 1),
                ")".repeat(depth - 1)
            ),
            "",
        ));
        for groups in [0, 1, depth / 2, depth - 1] {
            let classes = depth - groups;
            let pattern = format!(
                "{}{}a{}{}",
                "(?:x|".repeat(groups),
                "[".repeat(classes),
                "]".repeat(classes),
                ")".repeat(groups)
            );
            corpus.push((pattern[..pattern.len() - 1].to_string(), "v"));
            corpus.push((pattern, "v"));
        }
    }
    corpus.push((format!("(?<={})b", "a(?:c|d)".repeat(2000)), ""));
    corpus.push((
        format!(
            "[\\q{{{}}}]",
            (0..2000)
                .map(|i| format!("x{i}_"))
                .collect::<Vec<_>>()
                .join("|")
        ),
        "v",
    ));
    corpus
}

/// The digest of compiling and validating every corpus pattern.
fn digest() -> (usize, u64) {
    let corpus = corpus();
    let mut hash = Fnv(0xcbf2_9ce4_8422_2325);
    for (pattern, flags) in &corpus {
        let units: Vec<u16> = pattern.encode_utf16().collect();
        let mut checks = Vec::new();
        let mut check = |raw: u64| {
            checks.push(raw);
            true
        };
        let full = compile_units_checked(&units, flags, u64::MAX, Some(&mut check));
        match &full.result {
            Ok(program) => {
                hash.str("ok");
                for &word in &program.code {
                    hash.bytes(&word.to_le_bytes());
                }
                for count in [
                    program.capture_count,
                    program.name_count,
                    program.assertion_count,
                    program.quantifier_count,
                ] {
                    hash.u64(count as u64);
                }
                hash.u64(program.compile_meter_raw);
                for (name, index) in &program.capture_group_names {
                    hash.str(name);
                    hash.u64(*index as u64);
                }
            }
            Err(error) => hash.str(&format!("{error:?}")),
        }
        hash.u64(full.work_meter_raw);
        for raw in checks {
            hash.u64(raw);
        }
        let validated = validate_units_checked(&units, flags, u64::MAX, None);
        hash.str(&format!("{:?}", validated.result));
        hash.u64(validated.work_meter_raw);
        let units_total = full.work_meter_raw / ironhorse_regexp::XS_PARSE_REGEXP_METERING;
        for budget in [
            1,
            7,
            64,
            units_total / 3,
            units_total / 2,
            units_total.saturating_sub(1),
        ] {
            let stopped = compile_units_checked(&units, flags, budget, None);
            hash.str(&format!("{:?}", stopped.result.as_ref().map(|_| ())));
            hash.u64(stopped.work_meter_raw);
        }
    }
    (corpus.len(), hash.0)
}

#[test]
fn the_compiler_output_matches_the_recursive_compilers_digest() {
    assert_eq!(digest(), (GOLDEN_COUNT, GOLDEN_DIGEST));
}

const GOLDEN_COUNT: usize = 4737;
const GOLDEN_DIGEST: u64 = 0x7ac3_4ce2_d32b_ead4;
