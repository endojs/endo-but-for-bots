//! The XSRE matcher parity suite: every supported pattern/input is
//! checked **bit-exact** against the XS pin (`fxCompileRegExp` +
//! `fxMatchRegExp`, reached through the `xs-oracle` shim) — the
//! matched/not-matched answer, every capture's `(from, to)` byte
//! offsets, and the matcher's per-step meter (`match_meter_raw`).
//!
//! The compile meter is deliberately *not* asserted here: the shim's
//! compile number folds in `fxNewChunk`'s `XS_CHUNK_ALLOCATION_METERING`
//! over the code and data buffers — a C-allocator artifact the safe-Rust
//! port (which uses `Vec`, not the GC heap) structurally does not incur,
//! and which the design already excludes from the parity number ("run
//! metering excludes parse/allocation metering"). The matcher's per-step
//! meter is the consensus-relevant cost, and *that* is pinned exactly.
//!
//! A pattern the oracle compiles but this increment names
//! [`CompileError::Unsupported`] (the `i`/`u`/`v` flags, named captures,
//! `\p`, …) is an HONEST NAMED skip: it is counted and reported, never
//! silently passed and never asserted as a divergence.

use xs_oracle::regexp as oracle_regexp;
use ironhorse_regexp::{compile, match_regexp, CompileError};

/// One parity case: `(pattern, flags, subject, start_byte_offset)`.
type Case = (&'static str, &'static str, &'static str, i32);

/// Compare one case bit-exact; returns `Ok(true)` on a checked match,
/// `Ok(false)` on an honest named skip, or `Err(msg)` on a divergence.
fn check(case: Case) -> Result<bool, String> {
    let (pattern, flags, subject, start) = case;
    let oracle = oracle_regexp(pattern, flags, subject, start)
        .ok_or_else(|| format!("oracle machine failure for /{}/{}", pattern, flags))?;

    match compile(pattern, flags) {
        Err(CompileError::Unsupported(_)) => {
            // Honest named skip — the oracle may well compile it.
            return Ok(false);
        }
        Err(CompileError::Syntax(msg)) => {
            if oracle.compiled {
                return Err(format!(
                    "/{}/{}: oracle compiled but ironhorse errored: {}",
                    pattern, flags, msg
                ));
            }
            // Both reject — a matching compile error.
            return Ok(true);
        }
        Ok(program) => {
            if !oracle.compiled {
                return Err(format!(
                    "/{}/{}: ironhorse compiled but oracle rejected ({})",
                    pattern, flags, oracle.error
                ));
            }
            let outcome = match_regexp(&program, subject.as_bytes(), start);
            if outcome.matched != oracle.matched {
                return Err(format!(
                    "/{}/{} on {:?}@{}: matched ironhorse={} oracle={}",
                    pattern, flags, subject, start, outcome.matched, oracle.matched
                ));
            }
            // Compare every capture pair the oracle reports.
            for i in 0..oracle.captures.len() {
                let mine = outcome.captures.get(i).copied().unwrap_or((-2, -2));
                if mine != oracle.captures[i] {
                    return Err(format!(
                        "/{}/{} on {:?}@{}: capture[{}] ironhorse={:?} oracle={:?}",
                        pattern, flags, subject, start, i, mine, oracle.captures[i]
                    ));
                }
            }
            if outcome.captures.len() != oracle.captures.len() {
                return Err(format!(
                    "/{}/{}: capture count ironhorse={} oracle={}",
                    pattern,
                    flags,
                    outcome.captures.len(),
                    oracle.captures.len()
                ));
            }
            // The metering bar: per-step match meter, bit-exact.
            if outcome.match_meter_raw != oracle.match_meter_raw as u64 {
                return Err(format!(
                    "/{}/{} on {:?}@{}: match meter ironhorse={} oracle={}",
                    pattern, flags, subject, start, outcome.match_meter_raw, oracle.match_meter_raw
                ));
            }
            Ok(true)
        }
    }
}

/// The curated case corpus, one entry per grammar surface the stage bar
/// names. Kept ASCII/BMP (astral is a named skip), covering character
/// classes, greedy/lazy quantifiers, groups/backreferences, anchors,
/// alternation, lookaround, and pathological backtracking.
fn corpus() -> Vec<Case> {
    let mut v: Vec<Case> = Vec::new();

    // Literals and sequences.
    for &s in &["abcd", "xabcy", "", "ab", "abcabc"] {
        v.push(("abc", "", s, 0));
        v.push(("b", "", s, 0));
    }
    // Start offsets.
    v.push(("a", "", "aba", 1));
    v.push(("a", "", "aba", 2));
    v.push(("abc", "", "xxabc", 2));

    // `.` with and without dotAll.
    for &s in &["a\nb", "a b", "abc"] {
        v.push((".", "", s, 0));
        v.push((".", "s", s, 0));
        v.push(("a.c", "", s, 0));
    }

    // Character classes: ranges, negation, escapes.
    for &s in &["12345", "a1b2", "  x", "A_z9", "hello world", "[]", "-", "a-z"] {
        v.push(("[0-9]+", "", s, 0));
        v.push(("[^0-9]+", "", s, 0));
        v.push(("[a-z]", "", s, 0));
        v.push(("[A-Za-z_]+", "", s, 0));
        v.push(("[-a-z]", "", s, 0));
        v.push(("[a-z-]", "", s, 0));
        v.push(("\\d+", "", s, 0));
        v.push(("\\D+", "", s, 0));
        v.push(("\\w+", "", s, 0));
        v.push(("\\W+", "", s, 0));
        v.push(("\\s+", "", s, 0));
        v.push(("\\S+", "", s, 0));
    }

    // Control / hex / unicode escapes.
    v.push(("a\\tb", "", "a\tb", 0));
    v.push(("\\n", "", "x\ny", 0));
    v.push(("\\x41", "", "A", 0));
    v.push(("\\u0042", "", "B", 0));
    v.push(("\\.", "", "a.b", 0));
    v.push(("[\\x30-\\x39]+", "", "0129", 0));

    // Quantifiers, greedy and lazy.
    for &s in &["", "a", "aa", "aaa", "aaab", "baaa", "xayaz"] {
        v.push(("a*", "", s, 0));
        v.push(("a+", "", s, 0));
        v.push(("a?", "", s, 0));
        v.push(("a*?", "", s, 0));
        v.push(("a+?", "", s, 0));
        v.push(("a??b", "", s, 0));
        v.push(("a{2}", "", s, 0));
        v.push(("a{2,}", "", s, 0));
        v.push(("a{1,2}", "", s, 0));
        v.push(("a{2,3}?", "", s, 0));
    }

    // Groups: capturing, non-capturing, nested, quantified.
    v.push(("(a)(b)(c)", "", "abc", 0));
    v.push(("(ab)+", "", "ababab", 0));
    v.push(("(?:ab)+", "", "ababab", 0));
    v.push(("(a(b)c)", "", "abc", 0));
    v.push(("(a|b)+", "", "abba", 0));
    v.push(("(a)?b", "", "b", 0));
    v.push(("(a)?b", "", "ab", 0));
    v.push(("(abc)*", "", "abcabc", 0));

    // Backreferences.
    v.push(("(ab)\\1", "", "abab", 0));
    v.push(("(a+)\\1", "", "aaaa", 0));
    v.push(("(.)\\1", "", "xx", 0));
    v.push(("(.)\\1", "", "xy", 0));
    v.push(("(a)(b)\\2\\1", "", "abba", 0));

    // Named capture groups. A `(?<name>…)` group codegens identically to
    // its numbered peer, so the whole-match / capture offsets AND the
    // per-step meter must stay bit-exact with XS; a `\k<name>` reference
    // resolves through the runtime `names[]` array like `\N`.
    for &s in &["2026-08-14", "abcd", "", "x"] {
        v.push(("(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})", "", s, 0));
        v.push(("(?<a>.)(?<b>.)", "", s, 0));
    }
    v.push(("(?<w>\\w+)", "", "hello world", 0));
    v.push(("(?<pair>(?<inner>a)b)c", "", "abc", 0)); // nested named groups
    v.push(("(?<opt>x)?y", "", "y", 0)); // unmatched named group -> (-1,-1)
    v.push(("(?<opt>x)?y", "", "xy", 0));
    v.push(("(?<a>x)|(?<b>y)", "", "y", 0)); // alternation, one side unset
    // Named backreferences (`\k<name>`), forward and backward.
    v.push(("(?<c>.)\\k<c>", "", "aa", 0));
    v.push(("(?<c>.)\\k<c>", "", "ab", 0));
    v.push(("(?<q>['\"]).*?\\k<q>", "", "say \"hi\" now", 0));
    v.push(("\\k<a>(?<a>x)", "", "x", 0)); // forward reference (matches empty then x)
    v.push(("(?<a>foo)(bar)\\2\\k<a>", "", "foobarbarfoo", 0)); // mixed named + numbered
    // Named groups fold under the `i` flag exactly as numbered groups do.
    v.push(("(?<h>h)(?<e>e)\\k<e>", "i", "hEE", 0));
    v.push(("(?<w>\\w+)", "i", "AbC", 0));

    // Anchors and word boundaries.
    for &s in &["hello", "  hi ", "a b c", "", "x", "cat cats"] {
        v.push(("^hello$", "", s, 0));
        v.push(("^\\w+", "", s, 0));
        v.push(("\\w+$", "", s, 0));
        v.push(("\\bcat\\b", "", s, 0));
        v.push(("\\Bat", "", s, 0));
        v.push(("^", "", s, 0));
        v.push(("$", "", s, 0));
    }
    // Multiline anchors.
    v.push(("^b", "m", "a\nb\nc", 0));
    v.push(("c$", "m", "a\nc\nb", 0));
    v.push(("^.", "m", "x\ny", 0));

    // Alternation.
    v.push(("cat|dog|bird", "", "hotdog", 0));
    v.push(("cat|dog|bird", "", "bluebird", 0));
    v.push(("a|ab", "", "ab", 0));
    v.push(("(foo|foobar)", "", "foobar", 0));

    // Lookaround.
    v.push(("a(?=b)", "", "ab", 0));
    v.push(("a(?=b)", "", "ac", 0));
    v.push(("a(?!b)", "", "ac", 0));
    v.push(("a(?!b)", "", "ab", 0));
    v.push(("(?<=a)b", "", "ab", 0));
    v.push(("(?<=a)b", "", "xb", 0));
    v.push(("(?<!a)b", "", "xb", 0));
    v.push(("(?<!a)b", "", "ab", 0));
    v.push(("\\d+(?=px)", "", "10px", 0));

    // Pathological backtracking (deterministic step behavior matters —
    // the meter must match the pin's exact backtrack count, not a
    // ReDoS-shortcut). Inputs are kept SMALL: the oracle shim leaves the
    // C matcher's meter interval unset, so a catastrophic pattern would
    // backtrack unbounded on both engines; small inputs exercise the
    // exact backtrack count without the exponential blowup.
    v.push(("(a+)+b", "", "aaac", 0));
    v.push(("(a+)*b", "", "aaac", 0));
    v.push(("(a|a)*b", "", "aaac", 0));
    v.push(("a?a?a?a?aaaa", "", "aaaa", 0));
    v.push(("(.*)(.*)(.*)x", "", "abcd", 0));
    // NOTE: a *nested unbounded empty* star such as `(a*)*b` is
    // deliberately excluded — the oracle shim leaves the C matcher's
    // meter interval unset, so XS itself backtracks unbounded on it
    // (verified: the pin does not terminate on `(a*)*b`/"aac"). It is a
    // both-engines pathology, not a port divergence; the fuzz generator
    // avoids applying an unbounded quantifier to a group for the same
    // reason.

    // Case-insensitive (`i`) flag — the non-u/v fold path.
    for &s in &["ABC", "abc", "AbC", "xyz", "Hello", "HELLO"] {
        v.push(("abc", "i", s, 0));
        v.push(("[a-c]+", "i", s, 0));
        v.push(("[A-C]+", "i", s, 0));
        v.push(("hello", "i", s, 0));
        v.push(("(h)(e)\\2", "i", s, 0));
        v.push(("\\w+", "i", s, 0));
        v.push(("[^a-c]", "i", s, 0));
        v.push(("a|B|c", "i", s, 0));
    }
    v.push(("K", "i", "k", 0));
    v.push(("[k]", "i", "K", 0));

    // Syntax errors (both must reject).
    v.push(("(", "", "x", 0));
    v.push((")", "", "x", 0));
    v.push(("[", "", "x", 0));
    v.push(("a{2,1}", "", "aa", 0));
    v.push(("*", "", "x", 0));

    v
}

#[test]
fn matcher_parity_against_the_pin() {
    let cases = corpus();
    let mut checked = 0usize;
    let mut skipped = 0usize;
    let mut failures: Vec<String> = Vec::new();
    for case in cases.iter().copied() {
        match check(case) {
            Ok(true) => checked += 1,
            Ok(false) => skipped += 1,
            Err(msg) => failures.push(msg),
        }
    }
    eprintln!(
        "xsre parity: total={} checked={} skipped(named)={} divergent={}",
        cases.len(),
        checked,
        skipped,
        failures.len()
    );
    assert!(
        failures.is_empty(),
        "matcher parity divergences:\n{}",
        failures.join("\n")
    );
    // The curated corpus is all supported grammar; nothing should skip.
    assert_eq!(skipped, 0, "curated corpus should contain no named skips");
    assert!(checked > 100, "corpus should exercise many cases, got {}", checked);
}
