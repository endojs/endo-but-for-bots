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
//! [`CompileError::Unsupported`] (inline modifiers, …) is an HONEST NAMED
//! skip: it is counted and reported, never
//! silently passed and never asserted as a divergence.

use ironhorse_regexp::{compile, match_regexp, CompileError};
use xs_oracle::regexp as oracle_regexp;

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
            // `fxCompileRegExp` charges exactly one parse-meter unit per
            // emitted byte. This pins the Rust program-size accounting even
            // though the oracle shim's raw compile figure additionally
            // includes XS GC-chunk allocation charges.
            let expected_compile_meter = program.code.len() as u64 * 4 * 1024;
            if program.compile_meter_raw != expected_compile_meter {
                return Err(format!(
                    "/{}/{}: compile meter ironhorse={} expected={}",
                    pattern, flags, program.compile_meter_raw, expected_compile_meter
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
/// classes/quantifiers/backreferences, Unicode properties, and unicodeSets
/// expressions/string alternatives. Every entry is fully ported (checked
/// bit-exact); the still-deferred surface is pinned separately in
/// [`inline_modifiers_remain_a_named_skip`].
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
    for &s in &[
        "12345",
        "a1b2",
        "  x",
        "A_z9",
        "hello world",
        "[]",
        "-",
        "a-z",
    ] {
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

    // `\p{…}` is a property escape in NON-Unicode mode too (XS dispatches
    // `p`/`P` unconditionally — a legacy `\p` is not an identity escape of
    // `p`). Locked bit-exact on ASCII/BMP subjects so the matcher path (byte
    // oriented for non-`u`) agrees with the pin, not just the accept verdict.
    for &flags in &["", "i", "g", "m"] {
        v.push(("\\p{L}", flags, "A", 0));
        v.push(("\\p{L}", flags, "5", 0));
        v.push(("\\p{L}", flags, "p{L}", 0));
        v.push(("\\P{L}", flags, "5", 0));
        v.push(("\\p{Nd}+", flags, "42a", 0));
        v.push(("[\\p{L}\\p{Nd}]+", flags, "ab12!", 0));
        v.push(("[^\\p{L}]", flags, "5", 0));
        v.push(("\\p{ASCII}", flags, "A", 0));
        v.push(("a\\p{L}c", flags, "abc", 0));
    }

    // ---- `v`: nested set expressions and finite string sets ----
    for &(pattern, subject) in &[
        ("[[a-z]&&[^aeiou]]+", "rhythm"),
        ("[[a-z]&&[^aeiou]]+", "aeiou"),
        ("[[a-z]--[aeiou]]+", "rhythm"),
        ("[[a-c][x-z]]+", "abxyz"),
        ("[\\p{ASCII}&&\\p{Letter}]+", "abcXYZ"),
        ("[\\p{ASCII}--\\p{Letter}]+", "123!"),
        ("[\\q{ab|a|xyz}]", "xyz"),
        ("[\\q{ab|a|xyz}]", "ab"),
        ("^[\\q{ab|a|xyz}]+$", "xyzaba"),
        ("[[\\q{ab|cd}]--[\\q{cd}]]", "ab"),
        ("[[\\q{ab|cd}]&&[\\q{cd|ef}]]", "cd"),
    ] {
        v.push((pattern, "v", subject, 0));
    }
    // Properties of strings include both multi-code-point alternatives and,
    // for Basic_Emoji/RGI_Emoji, ordinary single-code-point members.
    v.push(("^\\p{Basic_Emoji}$", "v", "\u{2600}\u{fe0f}", 0));
    v.push(("^\\p{Basic_Emoji}$", "v", "\u{1f600}", 0));
    v.push(("^\\p{Emoji_Keycap_Sequence}$", "v", "1\u{fe0f}\u{20e3}", 0));
    v.push((
        "^\\p{RGI_Emoji_Flag_Sequence}$",
        "v",
        "\u{1f1fa}\u{1f1f8}",
        0,
    ));
    v.push((
        "^\\p{RGI_Emoji_Modifier_Sequence}$",
        "v",
        "\u{1f44d}\u{1f3fd}",
        0,
    ));
    v.push((
        "^\\p{RGI_Emoji_ZWJ_Sequence}$",
        "v",
        "\u{1f469}\u{200d}\u{1f4bb}",
        0,
    ));

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

    // Inline modifiers `(?ims-ims:...)`: scoped case-fold, dot-all, multiline,
    // and their restoration at the group boundary, over inputs that exercise
    // both the added and the removed flag. Every one is fully ported, so the
    // emitted program, captures, and per-step meter all pin bit-exact.
    for &s in &["a", "A", "ab", "Ab", "AB", "aB", "a\nb", "A\nB", ""] {
        // Add ignoreCase only inside the group.
        v.push(("(?i:a)b", "", s, 0));
        v.push(("(?i:a)b", "", s, 0));
        v.push(("a(?i:b)c", "", s, 0));
        // Remove ignoreCase inside an `i` pattern.
        v.push(("a(?-i:b)", "i", s, 0));
        v.push(("(?-i:a)b", "i", s, 0));
        // Dot-all scoped on and off.
        v.push(("(?s:.)", "", s, 0));
        v.push(("(?s:.)x", "s", s, 0));
        v.push(("a(?-s:.)", "s", s, 0));
        // Multiline scoped on and off.
        v.push(("(?m:^b)", "", s, 0));
        v.push(("(?-m:$)", "m", s, 0));
        // Multiple flags, add and remove together.
        v.push(("(?im-s:a.b)", "", s, 0));
        v.push(("(?ims-:a)", "", s, 0));
        v.push(("(?i-:a)", "", s, 0));
        // Nesting: inner remove within an outer add and vice versa.
        v.push(("(?i:a(?-i:b)c)", "", s, 0));
        v.push(("(?-i:a(?i:b)c)", "i", s, 0));
        // A quantifier and a capture *inside* the scoped group.
        v.push(("(?i:a+)b", "", s, 0));
        v.push(("(?i:(a)b)\\1", "", s, 0));
        // A modifier group inside a lookahead / lookbehind.
        v.push(("a(?=(?i:b))", "", s, 0));
        v.push(("(?<=(?i:a))b", "", s, 0));
    }

    // Invalid inline modifiers (both must reject): empty add+remove, a repeated
    // flag, a non-modifier flag, and a directly-quantified modifier group.
    for &p in &["(?-:a)", "(?ii:a)", "(?i-i:a)", "(?g:a)", "(?i:a)+", "(?i:a"] {
        v.push((p, "", "a", 0));
    }

    // Duplicate named-capture groups (ES2025): legal across mutually-exclusive
    // disjunction alternatives (shared name slot), a SyntaxError within one
    // alternative. Accept/reject, captures, and the per-step meter pin exact.
    for &s in &["x", "y", "z", "xy", "yx", "ab", "", "a"] {
        v.push(("(?<a>x)|(?<a>y)", "", s, 0));
        v.push(("(?<a>x)|(?<b>y)", "", s, 0));
        v.push(("(?<a>.)|(?<a>..)", "", s, 0));
        v.push(("(?<n>a)|(?<n>b)|(?<n>c)", "", s, 0));
        v.push(("(?:(?<t>a)|(?<t>b))\\k<t>", "", s, 0));
        v.push(("((?<y>a)|(?<y>b))+", "", s, 0));
        v.push(("(?<a>x)(?:y|(?<a>z))", "", s, 0)); // `a` recurs only in the alt
    }
    // Rejected duplicates (both must reject): same alternative, and a trailing
    // reuse of a name that is live outside the disjunction.
    for &p in &[
        "(?<a>x)(?<a>y)",
        "(?<a>x)((?<b>y)|(?<a>z))",
        "(?<a>a)(?<a>b)|c",
    ] {
        v.push((p, "", "x", 0));
    }

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
    assert!(
        checked > 100,
        "corpus should exercise many cases, got {}",
        checked
    );
}

/// v-mode syntax rejection is pinned independently from execution parity:
/// reserved unescaped punctuators, mixed operators, invalid ranges, string
/// complements, and u/v mutual exclusion all reject in both engines.
#[test]
fn unicode_sets_syntax_and_execution_match_the_pin() {
    let cases: &[Case] = &[
        ("\\p{RGI_Emoji}", "v", "\u{1F600}", 0),
        ("[a&&b]", "v", "a", 0),
        ("[a&&a&&a]", "v", "a", 0),
        ("[a--b]", "v", "a", 0),
        ("[a--b--c]", "v", "a", 0),
        ("[[a][b]]", "v", "b", 0),
        ("[\\q{ab|cd}]", "v", "cd", 0),
        ("[\\q{|a|ab}]", "v", "a", 0),
        ("[\\q{\\nA|b}]", "v", "\nA", 0),
        ("[\\q{AB|xy}]", "iv", "ab", 0),
        ("[a&b]", "v", "x", 0),
        ("[a-b-c]", "v", "x", 0),
        ("[a&&b--c]", "v", "x", 0),
        ("[a&&b-c]", "v", "x", 0),
        ("[a--b&c]", "v", "x", 0),
        ("[\\d-a]", "v", "x", 0),
        ("[&&]", "v", "x", 0),
        ("[\\q", "v", "x", 0),
        ("[\\q{ab", "v", "x", 0),
        ("[[a]", "v", "x", 0),
        ("[^\\q{ab}]", "v", "x", 0),
        ("\\P{RGI_Emoji}", "v", "x", 0),
        ("a", "uv", "a", 0),
    ];
    for &case in cases {
        assert_eq!(check(case), Ok(true), "/{}/{} should agree", case.0, case.1);
    }
}

/// Inline modifiers are now fully ported: the emitted program, captures, and
/// per-step meter all pin bit-exact against the XS pin (they used to be a
/// named `Unsupported` skip). A spread of scoped/nested cases is asserted here
/// in addition to the corpus sweep, to lock the parity explicitly.
#[test]
fn inline_modifiers_execute_and_match_the_pin() {
    let cases: &[Case] = &[
        ("(?i:a)", "", "A", 0),
        ("(?i:a)b", "", "AB", 0),
        ("a(?-i:b)c", "i", "AbC", 0),
        ("(?s:.)", "", "\n", 0),
        ("(?m:^b)", "", "a\nb", 0),
        ("(?im-s:.)", "", "\n", 0),
        ("(?i:a(?-i:b)c)", "", "AbC", 0),
        ("(?i:(a)b)\\1", "", "AbA", 0),
        ("(?<=(?i:a))b", "", "Ab", 0),
    ];
    for &case in cases {
        assert!(
            matches!(compile(case.0, case.1), Ok(_)),
            "/{}/{} should compile",
            case.0,
            case.1
        );
        assert_eq!(check(case), Ok(true), "/{}/{} should agree", case.0, case.1);
    }
}
