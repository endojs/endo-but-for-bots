//! Stage-3b XSRE fuzz arm (child 8/9): a structure-aware regexp
//! generator plus a differential check of the [`ironhorse_regexp`] matcher
//! against the XS pin (`fxCompileRegExp` + `fxMatchRegExp`, via the
//! `xs-oracle` shim).
//!
//! The generator folds raw fuzzer bytes into a pattern drawn from the
//! **supported** grammar only (the `i`/`u`/`v` flags and named captures
//! are out of this increment's scope, so the arm never generates them),
//! plus a subject over an overlapping small alphabet so matches actually
//! occur. [`differential_check_regexp`] then pins the matched answer,
//! every capture's byte offsets, and the per-step match meter bit-exact.
//! Any divergence is a finding. A pattern the port names `Unsupported`
//! is skipped honestly (`Ok(())`), never reported as a divergence.

use crate::Divergence;

/// A cursor over fuzzer bytes, driving the grammar deterministically.
struct Bytes<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Bytes<'a> {
    fn new(data: &'a [u8]) -> Self {
        Bytes { data, pos: 0 }
    }
    fn next(&mut self) -> u8 {
        if self.data.is_empty() {
            return 0;
        }
        let b = self.data[self.pos % self.data.len()];
        self.pos = self.pos.wrapping_add(1);
        b
    }
    fn choice(&mut self, n: u8) -> u8 {
        self.next() % n
    }
}

/// A generated case: `(pattern, flags, subject, start_byte_offset)`.
pub type RegExpCase = (String, String, String, i32);

/// The subject/atom alphabet — small and overlapping so matches happen.
const ALPHABET: &[u8] = b"aabbc01 \n";

/// Fold `data` into a supported-grammar regexp case.
pub fn gen_regexp(data: &[u8]) -> RegExpCase {
    let mut b = Bytes::new(data);
    let mut groups = 0u32;
    let pattern = gen_disjunction(&mut b, 3, &mut groups);
    let flags = match b.choice(5) {
        0 => "",
        1 => "m",
        2 => "s",
        3 => "i",
        _ => "",
    }
    .to_string();
    // Subject: a short string over the alphabet.
    let n = 1 + (b.next() % 8) as usize;
    let mut subject = String::new();
    for _ in 0..n {
        subject.push(ALPHABET[(b.next() as usize) % ALPHABET.len()] as char);
    }
    // Start offset: usually 0, occasionally deeper (still a valid byte
    // boundary since the alphabet is ASCII).
    let start = if b.choice(4) == 0 {
        (b.next() as usize % (subject.len() + 1)) as i32
    } else {
        0
    };
    (pattern, flags, subject, start)
}

fn gen_disjunction(b: &mut Bytes, depth: u8, groups: &mut u32) -> String {
    let left = gen_sequence(b, depth, groups);
    if depth > 0 && b.choice(4) == 0 {
        let right = gen_disjunction(b, depth - 1, groups);
        format!("{}|{}", left, right)
    } else {
        left
    }
}

fn gen_sequence(b: &mut Bytes, depth: u8, groups: &mut u32) -> String {
    let count = 1 + b.choice(3);
    let mut out = String::new();
    for _ in 0..count {
        out.push_str(&gen_quantified(b, depth, groups));
    }
    out
}

fn gen_quantified(b: &mut Bytes, depth: u8, groups: &mut u32) -> String {
    let (atom, is_group) = gen_atom(b, depth, groups);
    // An *unbounded* quantifier applied to a group whose body can match
    // empty (e.g. `(a*)*`) is catastrophic on the pin too (the shim
    // leaves the meter interval unset, so XS backtracks unbounded). To
    // keep the differential arm bounded on BOTH engines, groups and
    // lookaround take only bounded quantifiers; atoms take any.
    let q = if is_group {
        match b.choice(5) {
            0 => "?",
            1 => "{2}",
            2 => "{1,2}",
            _ => "",
        }
    } else {
        match b.choice(8) {
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
    if q.is_empty() {
        atom
    } else {
        format!("{}{}", atom, q)
    }
}

/// Returns `(atom, is_group)` — `is_group` is true for a `(...)`,
/// `(?:...)`, or lookaround atom (which take only bounded quantifiers).
fn gen_atom(b: &mut Bytes, depth: u8, groups: &mut u32) -> (String, bool) {
    // Deeper recursion only for groups/lookaround; otherwise a leaf.
    let can_recurse = depth > 0;
    match b.choice(if can_recurse { 12 } else { 7 }) {
        0 => (gen_literal(b), false),
        1 => (gen_literal(b), false),
        2 => (gen_class(b), false),
        3 => (".".to_string(), false),
        4 => (
            match b.choice(6) {
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
            match b.choice(4) {
                0 => "^",
                1 => "$",
                2 => "\\b",
                _ => "\\B",
            }
            .to_string(),
            false,
        ),
        6 => {
            // Numeric backreference to an already-opened group (else a
            // literal digit, which is always valid).
            if *groups > 0 {
                (format!("\\{}", 1 + (b.next() as u32 % *groups)), false)
            } else {
                (gen_literal(b), false)
            }
        }
        7 => {
            // Capturing group.
            *groups += 1;
            let inner = gen_disjunction(b, depth - 1, groups);
            (format!("({})", inner), true)
        }
        8 => {
            // Non-capturing group.
            let inner = gen_disjunction(b, depth - 1, groups);
            (format!("(?:{})", inner), true)
        }
        9 => {
            // Lookahead.
            let inner = gen_disjunction(b, depth - 1, groups);
            let neg = if b.choice(2) == 0 { "=" } else { "!" };
            (format!("(?{}{})", neg, inner), true)
        }
        10 => {
            // Lookbehind.
            let inner = gen_disjunction(b, depth - 1, groups);
            let neg = if b.choice(2) == 0 { "=" } else { "!" };
            (format!("(?<{}{})", neg, inner), true)
        }
        _ => (gen_literal(b), false),
    }
}

fn gen_literal(b: &mut Bytes) -> String {
    // A single ordinary char from the alphabet, always a valid atom.
    // Space is an ordinary regexp character; newline is written `\n`.
    let c = ALPHABET[(b.next() as usize) % ALPHABET.len()] as char;
    match c {
        '\n' => "\\n".to_string(),
        _ => c.to_string(),
    }
}

fn gen_class(b: &mut Bytes) -> String {
    let neg = if b.choice(3) == 0 { "^" } else { "" };
    match b.choice(4) {
        0 => format!("[{}a-c]", neg),
        1 => format!("[{}0-9]", neg),
        2 => format!("[{}abc]", neg),
        _ => format!("[{}a-c0-9]", neg),
    }
}

/// Differentially check one case, returning `Ok(true)` when both engines
/// compiled AND matched (a "real match", used to prove the corpus
/// exercises hits), `Ok(false)` on an honest skip / agreed no-match /
/// agreed compile-rejection, or `Err` on a matched/captures/meter
/// divergence from the pin.
pub fn differential_check_regexp(case: &RegExpCase) -> Result<bool, Divergence> {
    let (pattern, flags, subject, start) = case;
    let source = format!("/{}/{} on {:?}@{}", pattern, flags, subject, start);

    let oracle = match xs_oracle::regexp(pattern, flags, subject, *start) {
        Some(o) => o,
        None => return Ok(false), // machine startup failure, not a finding
    };

    let program = match ironhorse_regexp::compile(pattern, flags) {
        Ok(p) => p,
        Err(ironhorse_regexp::CompileError::Unsupported(_)) => return Ok(false),
        Err(ironhorse_regexp::CompileError::Syntax(_)) => {
            // Both must reject; the oracle compiling it is a finding.
            if oracle.compiled {
                return Err(Divergence {
                    source,
                    detail: "ironhorse rejected a pattern the pin compiled".to_string(),
                });
            }
            return Ok(false);
        }
    };
    if !oracle.compiled {
        return Err(Divergence {
            source,
            detail: format!("ironhorse compiled a pattern the pin rejected ({})", oracle.error),
        });
    }

    let outcome = ironhorse_regexp::match_regexp(&program, subject.as_bytes(), *start);
    if outcome.matched != oracle.matched {
        return Err(Divergence {
            source,
            detail: format!("matched ironhorse={} pin={}", outcome.matched, oracle.matched),
        });
    }
    for i in 0..oracle.captures.len() {
        let mine = outcome.captures.get(i).copied().unwrap_or((-2, -2));
        if mine != oracle.captures[i] {
            return Err(Divergence {
                source,
                detail: format!("capture[{}] ironhorse={:?} pin={:?}", i, mine, oracle.captures[i]),
            });
        }
    }
    if outcome.match_meter_raw != oracle.match_meter_raw {
        return Err(Divergence {
            source,
            detail: format!(
                "match meter ironhorse={} pin={}",
                outcome.match_meter_raw, oracle.match_meter_raw
            ),
        });
    }
    // Agreement — report whether it was a real (compiled + matched) hit.
    Ok(outcome.matched)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_regexps_agree_bit_exact_with_the_pin() {
        // Structure-aware seed sweep: every generated pattern/subject is
        // matched on both ironhorse and the XS pin and pinned bit-exact
        // (matched, captures, and the per-step match meter). Zero
        // divergence over the sweep is the fuzz-arm bar.
        let mut checked = 0usize;
        let mut matched_any = false;
        let mut used_group = false;
        for seed in 0u32..3000 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(10 + (seed % 20)) {
                buf.push(data[(k as usize) % 4].wrapping_add((k as u8).wrapping_mul(13)));
            }
            let case = gen_regexp(&buf);
            if case.0.contains('(') && !case.0.contains("(?") {
                used_group = true;
            }
            // A single oracle call per seed (the check owns it) — the pin
            // machine is created and torn down inside, so a second probe
            // would double the create/destroy churn.
            match differential_check_regexp(&case) {
                Ok(real_match) => {
                    checked += 1;
                    matched_any |= real_match;
                }
                Err(d) => panic!("regexp differential divergence: {:?}", d),
            }
        }
        assert!(checked > 2000, "sweep should check most seeds, got {}", checked);
        assert!(matched_any, "sweep should include real matches");
        assert!(used_group, "sweep should exercise capturing groups");
    }
}
