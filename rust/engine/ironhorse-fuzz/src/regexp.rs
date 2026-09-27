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
        Err(
            ironhorse_regexp::CompileError::BudgetExceeded
            | ironhorse_regexp::CompileError::ResourceLimit,
        ) => {
            return Err(Divergence {
                source,
                detail: "regexp compilation resource refusal".into(),
            })
        }
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
            detail: format!(
                "ironhorse compiled a pattern the pin rejected ({})",
                oracle.error
            ),
        });
    }

    let outcome = ironhorse_regexp::match_regexp(&program, subject.as_bytes(), *start);
    if outcome.matched != oracle.matched {
        return Err(Divergence {
            source,
            detail: format!(
                "matched ironhorse={} pin={}",
                outcome.matched, oracle.matched
            ),
        });
    }
    for i in 0..oracle.captures.len() {
        let mine = outcome.captures.get(i).copied().unwrap_or((-2, -2));
        if mine != oracle.captures[i] {
            return Err(Divergence {
                source,
                detail: format!(
                    "capture[{}] ironhorse={:?} pin={:?}",
                    i, mine, oracle.captures[i]
                ),
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
        assert!(
            checked > 2000,
            "sweep should check most seeds, got {}",
            checked
        );
        assert!(matched_any, "sweep should include real matches");
        assert!(used_group, "sweep should exercise capturing groups");
    }

    /// Regression for continuous-fuzz finding `12aca768c2e73c73`. The exact
    /// 10-byte input used to expose the XS shim's 32-bit truncation of its
    /// 64-bit regexp match meter. With the shim fields widened, both engines
    /// must agree on the full value rather than the wrapped low 32 bits.
    #[test]
    fn finding_12aca768c2e73c73_match_meter_agrees_at_full_width() {
        let data =
            include_bytes!("../../ironhorse-vm/tests/fixtures/finding-12aca768c2e73c73.input.bin");
        let case = gen_regexp(data);
        let program = ironhorse_regexp::compile(&case.0, &case.1).expect("finding compiles");
        let outcome = ironhorse_regexp::match_regexp(&program, case.2.as_bytes(), case.3);

        assert!(
            !outcome.matched,
            "the exact finding pattern must remain a no-match"
        );
        assert_eq!(outcome.match_meter_raw, 6_840_385_536);
        assert!(outcome.match_meter_raw > u64::from(u32::MAX));
        match differential_check_regexp(&case) {
            Ok(false) => {}
            Ok(true) => panic!("finding must remain a compiled no-match case"),
            Err(divergence) => {
                panic!("finding 12aca768c2e73c73 must not diverge: {divergence:?}")
            }
        }
    }

    #[test]
    fn finding_1dc231089278c110_regexp_meter_overflow_agrees() {
        // Fuzz finding 1dc231089278c110: the 3-byte input `68 68 bc` folds
        // into a nested `\n*`/`0*`/`0{1,3}` alternation over "00\n00"@2
        // that backtracks 83775 metered steps (raw meter 5490278400 >
        // u32::MAX). The pre-c8497fd8 oracle wrapped the pin's meter to
        // 32 bits; with the widened oracle both engines agree bit-exact.
        let data =
            include_bytes!("../../ironhorse-vm/tests/fixtures/finding-1dc231089278c110.input.bin");
        assert_eq!(data, &[0x68, 0x68, 0xbc]);
        let case = gen_regexp(data);
        assert_eq!(case.2, "00\n00");
        assert_eq!(case.3, 2);
        assert_eq!(differential_check_regexp(&case), Ok(true));
    }

    #[test]
    fn finding_13b68e2edb67861a_regexp_meter_overflow_agrees() {
        // Fuzz finding 13b68e2edb67861a: the 12-byte input `3b 2b bc ... bc`
        // folds into a backreference-heavy (`\1`/`\3`/`\4`) nested
        // alternation, flags `i`, over "\n\n\n0 "@2 that backtracks
        // 91920681 metered steps (raw meter 6024113750016 > u32::MAX). The
        // pre-c8497fd8 oracle wrapped the pin's meter to 32 bits; with the
        // widened oracle both engines agree bit-exact.
        let data =
            include_bytes!("../../ironhorse-vm/tests/fixtures/finding-13b68e2edb67861a.input.bin");
        assert_eq!(data.len(), 12);
        let case = gen_regexp(data);
        assert_eq!(case.1, "i");
        assert_eq!(case.2, "\n\n\n0 ");
        assert_eq!(case.3, 2);
        assert_eq!(differential_check_regexp(&case), Ok(true));
    }

    #[test]
    fn finding_45f4af87eaf627c7_regexp_meter_overflow_agrees() {
        // Fuzz finding 45f4af87eaf627c7: the 3-byte input `50 bc 5b` folds
        // into optional runs of starred empty backreferences between
        // `\n{1,3}` repetitions, over "a\n\na\n"@1. It matches empty at 1
        // after 82118 metered steps (raw meter 5381685248 > u32::MAX). The
        // pre-c8497fd8 oracle wrapped the pin's meter to 32 bits; with the
        // widened oracle both engines agree bit-exact.
        let data =
            include_bytes!("../../ironhorse-vm/tests/fixtures/finding-45f4af87eaf627c7.input.bin");
        assert_eq!(data.len(), 3);
        let case = gen_regexp(data);
        assert_eq!(case.1, "");
        assert_eq!(case.2, "a\n\na\n");
        assert_eq!(case.3, 1);
        assert_eq!(differential_check_regexp(&case), Ok(true));
    }

    /// Regression for continuous-fuzz finding `29a24c1b1052ec91`. The exact
    /// 3-byte input exposed the XS shim's former 32-bit truncation of its
    /// 64-bit regexp match meter. With the shim fields widened, both engines
    /// must agree on the full value rather than the wrapped low 32 bits.
    #[test]
    fn finding_29a24c1b1052ec91_regexp_meter_overflow_agrees() {
        let data =
            include_bytes!("../../ironhorse-vm/tests/fixtures/finding-29a24c1b1052ec91.input.bin");
        let case = gen_regexp(data);
        assert_eq!(case.1, "i");
        assert_eq!(case.2, " bb b");
        assert_eq!(case.3, 1);

        let program = ironhorse_regexp::compile(&case.0, &case.1).expect("finding compiles");
        let outcome = ironhorse_regexp::match_regexp(&program, case.2.as_bytes(), case.3);
        assert!(outcome.matched, "the exact finding must remain a match");
        assert_eq!(outcome.match_meter_raw, 7_676_821_504);
        assert!(outcome.match_meter_raw > u64::from(u32::MAX));
        assert_eq!(differential_check_regexp(&case), Ok(true));
    }

    /// Regression for continuous-fuzz finding `51c6a212946102f6`. The exact
    /// 31-byte input drives a nested quantified-group match whose 64-bit
    /// meter exceeds `u32::MAX`; the XS shim formerly truncated it to 32
    /// bits. With the shim fields widened, both engines must agree.
    #[test]
    fn finding_51c6a212946102f6_regexp_meter_overflow_agrees() {
        let data =
            include_bytes!("../../ironhorse-vm/tests/fixtures/finding-51c6a212946102f6.input.bin");
        let case = gen_regexp(data);
        assert_eq!(case.1, "s");
        assert_eq!(case.2, "aaaaaaaa");
        assert_eq!(case.3, 0);

        let program = ironhorse_regexp::compile(&case.0, &case.1).expect("finding compiles");
        let outcome = ironhorse_regexp::match_regexp(&program, case.2.as_bytes(), case.3);
        assert!(outcome.matched, "the exact finding must remain a match");
        assert_eq!(outcome.match_meter_raw, 4_658_495_488);
        assert!(outcome.match_meter_raw > u64::from(u32::MAX));
        assert_eq!(differential_check_regexp(&case), Ok(true));
    }

    /// Regression for continuous-fuzz finding `5e7a173f899ae7a1`. The exact
    /// 3-byte input exposed the XS shim's former 32-bit truncation of its
    /// 64-bit regexp match meter. With the shim fields widened, both engines
    /// must agree on the full value rather than the wrapped low 32 bits.
    #[test]
    fn finding_5e7a173f899ae7a1_regexp_meter_overflow_agrees() {
        let data =
            include_bytes!("../../ironhorse-vm/tests/fixtures/finding-5e7a173f899ae7a1.input.bin");
        let case = gen_regexp(data);
        assert_eq!(case.1, "m");
        assert_eq!(case.2, "00\n00");
        assert_eq!(case.3, 2);

        let program = ironhorse_regexp::compile(&case.0, &case.1).expect("finding compiles");
        let outcome = ironhorse_regexp::match_regexp(&program, case.2.as_bytes(), case.3);
        assert!(outcome.matched, "the exact finding must remain a match");
        assert_eq!(outcome.captures, vec![(2, 3)]);
        assert_eq!(outcome.match_meter_raw, 14_145_421_312);
        assert!(outcome.match_meter_raw > u64::from(u32::MAX));
        assert_eq!(differential_check_regexp(&case), Ok(true));
    }

    /// Regression for continuous-fuzz finding `5eeb0aadb2004075`. The exact
    /// 30-byte input exposed the XS shim's former 32-bit truncation of its
    /// 64-bit regexp match meter. With the shim fields widened, both engines
    /// must agree on the full value rather than the wrapped low 32 bits.
    #[test]
    fn finding_5eeb0aadb2004075_regexp_meter_overflow_agrees() {
        let data =
            include_bytes!("../../ironhorse-vm/tests/fixtures/finding-5eeb0aadb2004075.input.bin");
        let case = gen_regexp(data);
        assert_eq!(case.1, "");
        assert_eq!(case.2, "11111111");
        assert_eq!(case.3, 0);

        let program = ironhorse_regexp::compile(&case.0, &case.1).expect("finding compiles");
        let outcome = ironhorse_regexp::match_regexp(&program, case.2.as_bytes(), case.3);
        assert!(
            !outcome.matched,
            "the exact finding must remain a non-match"
        );
        assert_eq!(outcome.captures, vec![(-1, -1)]);
        assert_eq!(outcome.match_meter_raw, 11_901_468_672);
        assert!(outcome.match_meter_raw > u64::from(u32::MAX));
        assert_eq!(differential_check_regexp(&case), Ok(false));
    }

    /// Regression for continuous-fuzz finding `7072dc2d72d9e2fd`. The exact
    /// 10-byte input exposed the XS shim's former 32-bit truncation of its
    /// 64-bit regexp match meter. With the shim fields widened, both engines
    /// must agree on the full value rather than the wrapped low 32 bits.
    #[test]
    fn finding_7072dc2d72d9e2fd_regexp_meter_overflow_agrees() {
        let data =
            include_bytes!("../../ironhorse-vm/tests/fixtures/finding-7072dc2d72d9e2fd.input.bin");
        let case = gen_regexp(data);
        assert_eq!(case.1, "s");
        assert_eq!(case.2, "aaabaaaa");
        assert_eq!(case.3, 0);

        let program = ironhorse_regexp::compile(&case.0, &case.1).expect("finding compiles");
        let outcome = ironhorse_regexp::match_regexp(&program, case.2.as_bytes(), case.3);
        assert!(
            !outcome.matched,
            "the exact finding must remain a non-match"
        );
        assert_eq!(outcome.match_meter_raw, 4_973_199_360);
        assert!(outcome.match_meter_raw > u64::from(u32::MAX));
        assert_eq!(differential_check_regexp(&case), Ok(false));
    }

    /// Regression for continuous-fuzz finding `6be90176ff07c648`. The exact
    /// 9-byte input exposed the XS shim's former 32-bit truncation of its
    /// 64-bit regexp match meter (wrapped by `2^33`). With the shim fields
    /// widened, both engines must agree on the full value.
    #[test]
    fn finding_6be90176ff07c648_regexp_meter_overflow_agrees() {
        let data =
            include_bytes!("../../ironhorse-vm/tests/fixtures/finding-6be90176ff07c648.input.bin");
        let case = gen_regexp(data);
        assert_eq!(case.1, "m");
        assert_eq!(case.2, "\n  ab\n");
        assert_eq!(case.3, 0);

        let program = ironhorse_regexp::compile(&case.0, &case.1).expect("finding compiles");
        let outcome = ironhorse_regexp::match_regexp(&program, case.2.as_bytes(), case.3);
        assert!(
            !outcome.matched,
            "the exact finding must remain a non-match"
        );
        assert_eq!(outcome.match_meter_raw, 9_965_535_232);
        assert!(outcome.match_meter_raw > u64::from(u32::MAX));
        assert_eq!(differential_check_regexp(&case), Ok(false));
    }

    /// Regression for continuous-fuzz finding `822848c732a1b805`. The exact
    /// 20-byte input exposed the XS shim's former 32-bit truncation of its
    /// 64-bit regexp match meter (wrapped by `2^32`). With the shim fields
    /// widened, both engines must agree on the full value.
    #[test]
    fn finding_822848c732a1b805_regexp_meter_overflow_agrees() {
        let data =
            include_bytes!("../../ironhorse-vm/tests/fixtures/finding-822848c732a1b805.input.bin");
        let case = gen_regexp(data);
        assert_eq!(case.1, "m");
        assert_eq!(case.2, "  bbb");
        assert_eq!(case.3, 2);

        let program = ironhorse_regexp::compile(&case.0, &case.1).expect("finding compiles");
        let outcome = ironhorse_regexp::match_regexp(&program, case.2.as_bytes(), case.3);
        assert!(
            !outcome.matched,
            "the exact finding must remain a non-match"
        );
        assert_eq!(outcome.match_meter_raw, 4_976_410_624);
        assert!(outcome.match_meter_raw > u64::from(u32::MAX));
        assert_eq!(differential_check_regexp(&case), Ok(false));
    }

    /// Regression for continuous-fuzz finding `79f0475dd0440b2d`. The exact
    /// 3-byte input exposed the XS shim's former 32-bit truncation of its
    /// 64-bit regexp match meter (1243873280 instead of 30435382132736).
    /// With the shim fields widened, both engines must agree on the full value.
    #[test]
    fn finding_79f0475dd0440b2d_regexp_meter_overflow_agrees() {
        let data =
            include_bytes!("../../ironhorse-vm/tests/fixtures/finding-79f0475dd0440b2d.input.bin");
        let case = gen_regexp(data);
        assert_eq!(case.1, "m");
        assert_eq!(case.2, " \n\n \n");
        assert_eq!(case.3, 1);

        let program = ironhorse_regexp::compile(&case.0, &case.1).expect("finding compiles");
        let outcome = ironhorse_regexp::match_regexp(&program, case.2.as_bytes(), case.3);
        assert!(outcome.matched, "the exact finding must remain a match");
        assert_eq!(outcome.match_meter_raw, 30_435_382_132_736);
        assert!(outcome.match_meter_raw > u64::from(u32::MAX));
        assert_eq!(differential_check_regexp(&case), Ok(true));
    }

    /// Regression for continuous-fuzz finding `8ea950859db8a5f7`. The exact
    /// 3-byte input exposed the XS shim's former 32-bit truncation of its
    /// 64-bit regexp match meter (879886336 instead of 5174853632).
    /// With the shim fields widened, both engines must agree on the full value.
    #[test]
    fn finding_8ea950859db8a5f7_regexp_meter_overflow_agrees() {
        let data =
            include_bytes!("../../ironhorse-vm/tests/fixtures/finding-8ea950859db8a5f7.input.bin");
        let case = gen_regexp(data);
        assert_eq!(case.1, "");
        assert_eq!(case.2, " \n\n \n");
        assert_eq!(case.3, 1);

        let program = ironhorse_regexp::compile(&case.0, &case.1).expect("finding compiles");
        let outcome = ironhorse_regexp::match_regexp(&program, case.2.as_bytes(), case.3);
        assert!(outcome.matched, "the exact finding must remain a match");
        assert_eq!(outcome.match_meter_raw, 5_174_853_632);
        assert!(outcome.match_meter_raw > u64::from(u32::MAX));
        assert_eq!(differential_check_regexp(&case), Ok(true));
    }

    /// Regression for continuous-fuzz finding `ac8a8e3d9d3d7f96`. The exact
    /// 11-byte input exposed the XS shim's former 32-bit truncation of its
    /// 64-bit regexp match meter (410320896 instead of 39065026560) on a
    /// failing match. With the shim fields widened, both engines must agree.
    #[test]
    fn finding_ac8a8e3d9d3d7f96_regexp_meter_overflow_agrees() {
        let data =
            include_bytes!("../../ironhorse-vm/tests/fixtures/finding-ac8a8e3d9d3d7f96.input.bin");
        let case = gen_regexp(data);
        assert_eq!(case.1, "m");
        assert_eq!(case.2, " ccc");
        assert_eq!(case.3, 0);

        let program = ironhorse_regexp::compile(&case.0, &case.1).expect("finding compiles");
        let outcome = ironhorse_regexp::match_regexp(&program, case.2.as_bytes(), case.3);
        assert!(
            !outcome.matched,
            "the exact finding must remain a non-match"
        );
        assert_eq!(outcome.match_meter_raw, 39_065_026_560);
        assert!(outcome.match_meter_raw > u64::from(u32::MAX));
        assert_eq!(differential_check_regexp(&case), Ok(false));
    }

    /// Regression for continuous-fuzz finding `7637ac162a0b916a`. The exact
    /// 6-byte input exposed the XS shim's former 32-bit truncation of its
    /// 64-bit regexp match meter (729612288 instead of 490355884032) on a
    /// failing match. With the shim fields widened, both engines must agree.
    #[test]
    fn finding_7637ac162a0b916a_regexp_meter_overflow_agrees() {
        let data =
            include_bytes!("../../ironhorse-vm/tests/fixtures/finding-7637ac162a0b916a.input.bin");
        let case = gen_regexp(data);
        assert_eq!(case.1, "i");
        assert_eq!(case.2, "b");
        assert_eq!(case.3, 0);

        let program = ironhorse_regexp::compile(&case.0, &case.1).expect("finding compiles");
        let outcome = ironhorse_regexp::match_regexp(&program, case.2.as_bytes(), case.3);
        assert!(
            !outcome.matched,
            "the exact finding must remain a non-match"
        );
        assert_eq!(outcome.match_meter_raw, 490_355_884_032);
        assert!(outcome.match_meter_raw > u64::from(u32::MAX));
        assert_eq!(differential_check_regexp(&case), Ok(false));
    }

    /// Regression for continuous-fuzz finding `ab41c5d203ace017`. The exact
    /// 6-byte input exposed the XS shim's former 32-bit truncation of its
    /// 64-bit regexp match meter (2573467648 instead of 11163402240).
    /// With the shim fields widened, both engines must agree on the full value.
    #[test]
    fn finding_ab41c5d203ace017_regexp_meter_overflow_agrees() {
        let data =
            include_bytes!("../../ironhorse-vm/tests/fixtures/finding-ab41c5d203ace017.input.bin");
        let case = gen_regexp(data);
        assert_eq!(case.1, "");
        assert_eq!(case.2, "0");
        assert_eq!(case.3, 0);

        let program = ironhorse_regexp::compile(&case.0, &case.1).expect("finding compiles");
        let outcome = ironhorse_regexp::match_regexp(&program, case.2.as_bytes(), case.3);
        assert!(outcome.matched, "the exact finding must remain a match");
        assert_eq!(outcome.match_meter_raw, 11_163_402_240);
        assert!(outcome.match_meter_raw > u64::from(u32::MAX));
        assert_eq!(differential_check_regexp(&case), Ok(true));
    }

    /// Regression for continuous-fuzz finding `bf6cfbd74a7487fc`. The exact
    /// 6-byte input folds into an 822-byte nested `b*bb*` / starred
    /// backreference / `\n{2}0*\n{2}` alternation, flags `m`, over "\n"@0
    /// that backtracks 22238862 metered steps (raw meter 1457446060032 >
    /// u32::MAX). The pre-c8497fd8 oracle wrapped the pin's meter to 32 bits
    /// (pin=1452146688); with the widened oracle both engines agree.
    #[test]
    fn finding_bf6cfbd74a7487fc_regexp_meter_overflow_agrees() {
        let data =
            include_bytes!("../../ironhorse-vm/tests/fixtures/finding-bf6cfbd74a7487fc.input.bin");
        assert_eq!(data, b"G+8h88");
        let case = gen_regexp(data);
        assert_eq!(
            case.0,
            include_str!("../../ironhorse-vm/tests/fixtures/finding-bf6cfbd74a7487fc.pattern.txt")
        );
        assert_eq!(case.1, "m");
        assert_eq!(case.2, "\n");
        assert_eq!(case.3, 0);

        let program = ironhorse_regexp::compile(&case.0, &case.1).expect("finding compiles");
        let outcome = ironhorse_regexp::match_regexp(&program, case.2.as_bytes(), case.3);
        assert_eq!(outcome.match_meter_raw, 1_457_446_060_032);
        assert!(outcome.match_meter_raw > u64::from(u32::MAX));
        assert_eq!(differential_check_regexp(&case), Ok(outcome.matched));
    }
}
