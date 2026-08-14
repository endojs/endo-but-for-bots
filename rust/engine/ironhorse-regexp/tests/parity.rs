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
//! [`CompileError::Unsupported`] (v-mode set expressions and string
//! properties, inline modifiers, …) is an HONEST NAMED skip: it is counted and reported, never
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
/// names: character classes, greedy/lazy quantifiers, groups/backreferences,
/// anchors, alternation, lookaround, pathological backtracking, the `i` fold,
/// and — since the `u`-core increment — the `u` flag's astral scalars,
/// `\u{...}` escapes, unicode (lower-ward) case fold, and unicode-aware
/// classes/quantifiers/backreferences, and Unicode properties. Every entry is fully ported (checked
/// bit-exact); the still-deferred surfaces are pinned separately in
/// [`deferred_surfaces_remain_named_skips`].
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

    // ---- the `u` flag's core execution (astral, `\u{}`, unicode fold) ----
    //
    // Every case here is fully ported, so it is `checked` (never a named
    // skip). The subjects are standard UTF-8; XS is fed the same bytes and
    // the offsets are compared bit-exact, meter included.
    let grin = "\u{1F600}"; // U+1F600, 4 UTF-8 bytes
    let grinning = "\u{1F600}\u{1F601}\u{1F602}";
    // Plain BMP grammar under `u` behaves as without it.
    for &s in &["abcd", "xabcy", "", "a1b2"] {
        v.push(("abc", "u", s, 0));
        v.push(("[a-z]+", "u", s, 0));
        v.push(("\\d+", "u", s, 0));
        v.push(("\\w+", "u", s, 0));
    }
    // Astral literals: matched whole, consumed as one 4-byte unit.
    v.push((grin, "u", grin, 0));
    v.push((&grinning[..], "u", &grinning[..], 0));
    v.push((".", "u", grin, 0));
    v.push(("..", "u", grin, 0)); // one astral is one dot, so `..` fails
    v.push(("^.$", "u", grin, 0));
    v.push((".", "u", &grinning[..], 0));
    v.push(("^...$", "u", &grinning[..], 0));
    v.push((".+", "u", &grinning[..], 0));
    v.push((".+?", "u", &grinning[..], 0));
    v.push((".{2}", "u", &grinning[..], 0));
    // `\u{...}` and the surrogate-pair `\uHHHH\uHHHH` form both denote the
    // astral scalar under `u`.
    v.push(("\\u{1F600}", "u", grin, 0));
    v.push(("\\uD83D\\uDE00", "u", grin, 0));
    v.push(("a\\u{1F600}b", "u", "a\u{1F600}b", 0));
    // Astral character classes and ranges.
    v.push(("[\\u{1F600}-\\u{1F64F}]", "u", grin, 0));
    v.push(("[\\u{1F600}-\\u{1F64F}]+", "u", &grinning[..], 0));
    v.push(("[\\u{1F610}-\\u{1F64F}]", "u", grin, 0)); // just below range
    v.push(("[^\\u{1F600}]", "u", grin, 0));
    v.push(("[a\\u{1F600}z]", "u", grin, 0));
    // Astral quantifiers and groups.
    v.push(("\u{1F600}+", "u", "\u{1F600}\u{1F600}\u{1F600}", 0));
    v.push(("(\u{1F600})\\1", "u", "\u{1F600}\u{1F600}", 0));
    v.push(("(\u{1F600})+", "u", "\u{1F600}\u{1F600}", 0));
    // Word boundary around an astral (non-word) char.
    v.push(("\\bfoo\\b\u{1F600}", "u", "foo\u{1F600}", 0));
    // Anchors and start offsets over astral.
    v.push((grin, "u", "x\u{1F600}", 1));

    // ---- `iu`: unicode case folding (lower-ward, including astral) ----
    for &s in &["ABC", "abc", "AbC", "HELLO"] {
        v.push(("abc", "iu", s, 0));
        v.push(("[a-c]+", "iu", s, 0));
        v.push(("[A-C]+", "iu", s, 0));
        v.push(("\\w+", "iu", s, 0));
        v.push(("[^a-c]", "iu", s, 0));
    }
    // Kelvin sign / K / k all fold together under the Fold table.
    v.push(("k", "iu", "K", 0));
    v.push(("k", "iu", "\u{212A}", 0));
    v.push(("K", "iu", "\u{212A}", 0));
    v.push(("[a-z]", "iu", "\u{212A}", 0)); // Kelvin folds to 'k' in [a-z]
    // Final/medial sigma family folds together.
    v.push(("\u{03C3}", "iu", "\u{03A3}", 0));
    v.push(("\u{03C2}", "iu", "\u{03A3}", 0));
    // Astral case folding (Deseret, Adlam) through the Fold1 table.
    v.push(("\u{10400}", "iu", "\u{10428}", 0));
    v.push(("\u{10428}", "iu", "\u{10400}", 0));
    v.push(("[\u{10400}-\u{10427}]", "iu", "\u{10428}", 0));
    v.push(("(\u{10400})\\1", "iu", "\u{10428}\u{10400}", 0));

    // Unicode property escapes: canonical aliases, binary properties,
    // categories, Script/Script_Extensions, complements, classes, and u/v
    // ignoreCase behavior all execute through the pinned XS endpoint tables.
    for &flags in &["u", "v"] {
        v.push(("\\p{ASCII}", flags, "A", 0));
        v.push(("\\p{ASCII}", flags, "\u{00E9}", 0));
        v.push(("\\P{ASCII}", flags, "\u{00E9}", 0));
        v.push(("\\p{Alphabetic}+", flags, "A\u{03B1}", 0));
        v.push(("\\p{L}+", flags, "A\u{03B1}", 0));
        v.push(("\\p{General_Category=Uppercase_Letter}", flags, "A", 0));
        v.push(("\\p{gc=Lu}", flags, "A", 0));
        v.push(("\\p{Script=Greek}", flags, "\u{03B1}", 0));
        v.push(("\\p{sc=Grek}", flags, "\u{03B1}", 0));
        v.push(("\\p{Script_Extensions=Hira}", flags, "\u{30FC}", 0));
        v.push(("\\p{scx=Kana}", flags, "\u{30FC}", 0));
        v.push(("[\\p{Letter}\\p{Number}]+", flags, "abc123", 0));
        v.push(("[^\\p{ASCII}]", flags, "\u{1F600}", 0));
    }
    v.push(("^\\p{Lowercase_Letter}$", "iu", "A", 0));
    v.push(("^\\P{Lowercase_Letter}$", "iu", "A", 0));
    v.push(("^\\p{Lowercase_Letter}$", "iv", "A", 0));
    v.push(("^\\P{Lowercase_Letter}$", "iv", "A", 0));

    // Exact spelling/casing is required; unsupported property names and
    // unsupported name=value families are syntax errors in both engines.
    v.push(("\\p{letter}", "u", "a", 0));
    v.push(("\\p{ASCII=Yes}", "u", "A", 0));
    v.push(("\\p{Block=Basic_Latin}", "u", "A", 0));

    // `u`-mode syntax errors (both must reject): under `u` an unknown
    // identity escape, an out-of-range `\u{}`, a bare quantifier brace, and
    // a lone `]`/`}` are SyntaxErrors that non-`u` tolerates.
    v.push(("\\M", "u", "M", 0));
    v.push(("\\u{110000}", "u", "x", 0));
    v.push(("a{", "u", "a{", 0));
    v.push(("]", "u", "]", 0));
    v.push(("}", "u", "}", 0));
    v.push(("\\1", "u", "x", 0)); // backref with no group

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

/// The surfaces still deferred after the property increment stay HONEST
/// named skips: the oracle compiles them, but ironhorse returns a named
/// `Unsupported` (never a wrong answer). This pins the "removed the skip only
/// where implemented" boundary: only v-mode string properties and
/// set-expression grammar remain here.
#[test]
fn deferred_surfaces_remain_named_skips() {
    let deferred: &[Case] = &[
        ("\\p{RGI_Emoji}", "v", "\u{1F600}", 0),
        ("[a&&b]", "v", "a", 0),
        ("[a--b]", "v", "a", 0),
        ("[[a][b]]", "v", "a", 0),
    ];
    for &case in deferred {
        let (pattern, flags, _, _) = case;
        // The oracle must accept it (so this really is a deferral, not a
        // shared reject), and ironhorse must name it Unsupported.
        let oracle = oracle_regexp(pattern, flags, "x", 0)
            .unwrap_or_else(|| panic!("oracle machine failure for /{pattern}/{flags}"));
        assert!(
            oracle.compiled,
            "/{pattern}/{flags} should compile on the oracle (a real deferral)"
        );
        match compile(pattern, flags) {
            Err(CompileError::Unsupported(_)) => {}
            other => panic!(
                "/{pattern}/{flags} must stay a named Unsupported skip, got {other:?}"
            ),
        }
        // And it is counted as a skip (not a divergence) by the harness.
        assert_eq!(check(case), Ok(false), "/{pattern}/{flags} should be a named skip");
    }
}
