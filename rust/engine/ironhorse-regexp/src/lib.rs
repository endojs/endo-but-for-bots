#![forbid(unsafe_code)]
//! ironhorse-regexp: the safe, engine-internal transliteration of the XS
//! RegExp engine (`c/moddable` pin `xsre.c`), per the design's resolved
//! question 6 (the matcher is ported as an engine-internal module; the
//! JavaScript `RegExp` surface is child 9's integration).
//!
//! It delivers the two halves of the pin's engine:
//!
//! - [`compile`] — the `fxCompileRegExp` pipeline: recursive-descent
//!   parse into a term tree, a `measure` pass assigning each term its
//!   byte offset, and a `code` pass emitting the integer step stream.
//!   The compile meter (`XS_PARSE_REGEXP_METERING`) is carried through so
//!   child 9 can calibrate end-to-end.
//! - [`match_regexp`] — the `fxMatchRegExp` backtracking VM over that
//!   step stream, metering `XS_REGEXP_METERING` per dispatched step.
//!
//! Both are `#![forbid(unsafe_code)]`: the arena/`Vec` model removes the
//! raw pointers XS uses, so the compiler and matcher are compiler-checked
//! memory-safe. Only `xs-oracle` (the dev/CI differential harness)
//! links C.
//!
//! ## Scope and honest skips (the stage bar)
//!
//! This engine ports the core grammar: literals, `.`, character classes
//! (`[...]` with ranges, negation, `\d\D\w\W\s\S`, control/hex/`\uXXXX`
//! escapes), anchors (`^ $ \b \B`), groups (capturing and `(?:...)`),
//! quantifiers (`* + ? {n,m}`, greedy and lazy), disjunction (`|`), numeric
//! backreferences (`\1`..), and lookaround (`(?=) (?!) (?<=) (?<!)`). The `i`
//! flag (case folding) and named captures (`(?<name>)` / `\k<name>`) are
//! ported, as is the **`u` flag's core execution**: astral (`> 0xFFFF`) code
//! points kept whole and consumed as one unit, `\u{...}` escapes, the
//! unicode (lower-ward) case fold and its interaction with classes/ranges/`\w`,
//! and unicode-aware backreferences.
//!
//! Unicode property escapes (`\p{}` / `\P{}`) use the canonical binary,
//! general-category, Script, and Script_Extensions aliases and endpoint tables
//! extracted from the pinned XS source. The `v` flag's nested set-expression
//! grammar, finite string sets (`\q{...}`), and Unicode properties of strings
//! are also ported, including their pinned syntax restrictions and case-folding
//! behavior. Inline modifiers (`(?ims-ims:...)`) are ported: the scoped flag
//! word applies to the enclosed disjunction and is restored at the sequel step
//! (the matcher's `cxModifiersStep`). Every remaining deferred surface is a
//! **named** [`compile::CompileError::Unsupported`], never a wrong meter or a
//! wrong value.

mod charcase;
mod encoding;
mod flags;
mod opcode;
mod unicode_property;

pub mod compile;
pub mod matcher;
pub mod unicode;

pub use compile::{compile, CompileError, Program, MAX_NESTING_DEPTH};
pub use flags::{
    XS_REGEXP_D, XS_REGEXP_G, XS_REGEXP_I, XS_REGEXP_M, XS_REGEXP_N, XS_REGEXP_S, XS_REGEXP_U,
    XS_REGEXP_V, XS_REGEXP_Y,
};
pub use matcher::{match_regexp, match_regexp_checked, MatchOutcome, MATCH_CHECK_STRIDE};

/// The result of compiling and running one pattern: a convenience over
/// [`compile`] + [`match_regexp`] mirroring what the oracle shim returns,
/// so a caller (and the parity suite) can compare in one shape.
#[derive(Debug, Clone)]
pub struct RunOutcome {
    /// The whole-match plus capture-group `(from, to)` byte offsets.
    pub outcome: MatchOutcome,
    /// The compiled program (counts + compile meter).
    pub program: Program,
}

/// Compile `pattern` under `flags` and match it over `subject` (a UTF-8
/// string) from byte offset `start`. Returns the compile error (syntax or
/// a named unsupported feature) on a compile failure.
pub fn run(
    pattern: &str,
    flags: &str,
    subject: &str,
    start: i32,
) -> Result<RunOutcome, CompileError> {
    let program = compile(pattern, flags)?;
    let outcome = match_regexp(&program, subject.as_bytes(), start);
    Ok(RunOutcome { outcome, program })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(pattern: &str, flags: &str, subject: &str) -> (bool, Vec<(i32, i32)>) {
        let r = run(pattern, flags, subject, 0).expect("compiles");
        (r.outcome.matched, r.outcome.captures)
    }

    #[test]
    fn literal_and_group() {
        let (m, c) = caps("b(c)", "", "abcd");
        assert!(m);
        assert_eq!(c[0], (1, 3));
        assert_eq!(c[1], (2, 3));
    }

    #[test]
    fn no_match() {
        let (m, c) = caps("xyz", "", "abcd");
        assert!(!m);
        assert_eq!(c[0], (-1, -1));
    }

    #[test]
    fn greedy_star() {
        let (m, c) = caps("a*", "", "aaab");
        assert!(m);
        assert_eq!(c[0], (0, 3));
    }

    #[test]
    fn lazy_star() {
        let (m, c) = caps("a*?b", "", "aaab");
        assert!(m);
        assert_eq!(c[0], (0, 4));
    }

    #[test]
    fn char_class_and_anchor() {
        let (m, c) = caps("^[0-9]+$", "", "12345");
        assert!(m);
        assert_eq!(c[0], (0, 5));
    }

    #[test]
    fn alternation() {
        let (m, c) = caps("cat|dog", "", "hotdog");
        assert!(m);
        assert_eq!(c[0], (3, 6));
    }

    #[test]
    fn backreference() {
        let (m, c) = caps("(ab)\\1", "", "abab");
        assert!(m);
        assert_eq!(c[0], (0, 4));
        assert_eq!(c[1], (0, 2));
    }

    #[test]
    fn named_capture_groups_match_and_expose_names() {
        // A named group is a numbered group with a name: the capture
        // offsets are those of its ordinal position, and the compiler
        // exposes `(name, capture_index)` in name-slot order for the JS
        // `.groups` surface.
        let r = run("(?<year>\\d{4})-(?<month>\\d{2})", "", "2026-08", 0).expect("compiles");
        assert!(r.outcome.matched);
        assert_eq!(r.outcome.captures[0], (0, 7));
        assert_eq!(r.outcome.captures[1], (0, 4)); // year
        assert_eq!(r.outcome.captures[2], (5, 7)); // month
        assert_eq!(
            r.program.capture_group_names,
            vec![("year".to_string(), 1), ("month".to_string(), 2)]
        );
    }

    #[test]
    fn named_capture_index_follows_ordinal_position() {
        // A leading unnamed group shifts the named group's ordinal index;
        // the slot (name order) is independent of the capture index.
        let r = run("(a)(?<tail>b)", "", "ab", 0).expect("compiles");
        assert_eq!(r.outcome.captures[1], (0, 1)); // unnamed group 1
        assert_eq!(r.outcome.captures[2], (1, 2)); // named group 2
        assert_eq!(r.program.capture_group_names, vec![("tail".to_string(), 2)]);
    }

    #[test]
    fn named_backreference_matches_and_forward_ref_is_empty() {
        // `\k<name>` matches the text the named group captured.
        let (m, c) = caps("(?<c>.)\\k<c>", "", "aa");
        assert!(m);
        assert_eq!(c[0], (0, 2));
        assert!(!caps("(?<c>.)\\k<c>", "", "ab").0);
        // A forward reference to a not-yet-matched group matches empty.
        let (fm, fc) = caps("\\k<a>(?<a>x)", "", "x");
        assert!(fm);
        assert_eq!(fc[0], (0, 1));
    }

    #[test]
    fn unmatched_named_group_is_unset() {
        // An optional named group that does not participate is (-1, -1),
        // which the JS surface renders as `groups.opt === undefined`.
        let r = run("(?<opt>x)?y", "", "y", 0).expect("compiles");
        assert!(r.outcome.matched);
        assert_eq!(r.outcome.captures[1], (-1, -1));
        assert_eq!(r.program.capture_group_names, vec![("opt".to_string(), 1)]);
    }

    #[test]
    fn duplicate_named_groups_share_a_slot_across_alternatives() {
        // ES2025: the same name may appear in mutually-exclusive alternatives.
        // Both groups share one name slot, so `name_count` is 1 and there is a
        // single `.groups` key; the matcher's runtime `names[]` resolves it to
        // whichever alternative matched.
        let r = run("(?<a>x)|(?<a>y)", "", "y", 0).expect("compiles");
        assert!(r.outcome.matched);
        assert_eq!(r.program.name_count, 1);
        assert_eq!(r.program.capture_group_names, vec![("a".to_string(), 1)]);
        assert_eq!(r.outcome.captures[1], (-1, -1)); // left group unset
        assert_eq!(r.outcome.captures[2], (0, 1)); // right group matched "y"
        assert_eq!(r.outcome.names, vec![2]); // slot 0 → capture 2
        // The other branch: "x" matches the left group.
        let r2 = run("(?<a>x)|(?<a>y)", "", "x", 0).expect("compiles");
        assert_eq!(r2.outcome.names, vec![1]);
        assert_eq!(r2.outcome.captures[1], (0, 1));
    }

    #[test]
    fn duplicate_named_groups_in_one_alternative_are_rejected() {
        // Two same-named groups both live in one alternative is still a
        // SyntaxError (`mxDuplicateCapture`).
        assert!(matches!(
            compile("(?<a>x)(?<a>y)", ""),
            Err(CompileError::Syntax(_))
        ));
        // A trailing group re-using a name from inside a disjunction is a
        // duplicate (both can be live in the same match).
        assert!(matches!(
            compile("(?<a>x)((?<b>y)|(?<a>z))", ""),
            Err(CompileError::Syntax(_))
        ));
    }

    #[test]
    fn lookahead() {
        let (m, c) = caps("a(?=b)", "", "ab");
        assert!(m);
        assert_eq!(c[0], (0, 1));
    }

    #[test]
    fn case_insensitive_flag() {
        let (m, c) = caps("abc", "i", "xABCy");
        assert!(m);
        assert_eq!(c[0], (1, 4));
        let (m2, _) = caps("[a-c]+", "i", "ABCabc");
        assert!(m2);
    }

    #[test]
    fn u_flag_core_executes_not_skipped() {
        // The `u` flag's core grammar now runs for real — a plain pattern
        // under `u` compiles and matches, it is no longer a named skip.
        let (m, c) = caps("abc", "u", "xabcy");
        assert!(m);
        assert_eq!(c[0], (1, 4));
    }

    #[test]
    fn u_flag_astral_matches_whole_code_point() {
        // An astral literal under `u` is one code point: `😀` (U+1F600,
        // 4 UTF-8 bytes) matches the 4-byte subject as a single unit.
        let (m, c) = caps("a\u{1F600}b", "u", "a\u{1F600}b");
        assert!(m);
        assert_eq!(c[0], (0, 6)); // 1 + 4 + 1 bytes
                                  // `.` under `u` consumes the whole astral scalar (4 bytes), not a
                                  // surrogate half.
        let (dm, dc) = caps(".", "u", "\u{1F600}");
        assert!(dm);
        assert_eq!(dc[0], (0, 4));
    }

    #[test]
    fn cesu8_subject_distinguishes_code_units_by_unicode_mode() {
        let subject = [0xED, 0xA0, 0xBD, 0xED, 0xB8, 0x80];

        let plain = compile(".", "").expect("plain dot compiles");
        let plain_match = match_regexp(&plain, &subject, 0);
        assert!(plain_match.matched);
        assert_eq!(plain_match.captures[0], (0, 3));

        let unicode = compile(".", "u").expect("unicode dot compiles");
        let unicode_match = match_regexp(&unicode, &subject, 0);
        assert!(unicode_match.matched);
        assert_eq!(unicode_match.captures[0], (0, 6));

        let literal = compile("😀", "").expect("astral literal compiles as surrogates");
        let literal_match = match_regexp(&literal, &subject, 0);
        assert!(literal_match.matched);
        assert_eq!(literal_match.captures[0], (0, 6));
    }

    #[test]
    fn u_flag_braced_escape_and_astral_class() {
        // `\u{1F600}` is the same astral scalar; a class range spanning astral
        // matches it, and one just outside does not.
        assert!(caps("\\u{1F600}", "u", "\u{1F600}").0);
        assert!(caps("[\\u{1F600}-\\u{1F64F}]", "u", "\u{1F603}").0);
        assert!(!caps("[\\u{1F610}-\\u{1F64F}]", "u", "\u{1F600}").0);
    }

    #[test]
    fn u_flag_ignore_case_folds_lower_ward_including_astral() {
        // Under `iu` the fold is lower-ward (Fold table): `K` (0x4B), `k`
        // (0x6B) and the Kelvin sign `K` (U+212A) all canonicalize to `k`.
        assert!(caps("k", "iu", "K").0);
        assert!(caps("k", "iu", "\u{212A}").0);
        assert!(caps("[a-z]", "iu", "A").0);
        // Astral case folding: Deseret capital (U+10400) folds to small
        // (U+10428) under the Fold1 table.
        assert!(caps("\u{10400}", "iu", "\u{10428}").0);
        assert!(caps("\u{10428}", "iu", "\u{10400}").0);
    }

    #[test]
    fn u_flag_word_class_folds_lower_ward() {
        // `\w` under `iu` keeps `a`..`z` (lower-ward fold), so an uppercase
        // subject letter still matches (it folds into the set).
        assert!(caps("\\w", "iu", "Z").0);
        assert!(caps("\\w", "iu", "z").0);
    }

    #[test]
    fn u_flag_backreference_folds_under_ignore_case() {
        // A backreference under `iu` compares folded code points.
        let (m, c) = caps("(\u{1F600})\\1", "u", "\u{1F600}\u{1F600}");
        assert!(m);
        assert_eq!(c[0], (0, 8)); // two 4-byte astral scalars
        assert!(caps("(k)\\1", "iu", "K\u{212A}").0);
    }

    #[test]
    fn v_flag_sets_and_string_properties_execute() {
        assert!(caps("abc", "v", "abc").0);
        assert!(caps("\\p{Script=Greek}+", "v", "\u{03B1}\u{03B2}").0);
        assert!(caps("[\\p{ASCII}]", "v", "A").0);
        assert!(caps("[[a-z]&&[^aeiou]]+", "v", "rhythm").0);
        assert!(!caps("[[a-z]&&[^aeiou]]", "v", "a").0);
        assert!(caps("[\\q{ab|xyz}]", "v", "xyz").0);
        assert!(caps("\\p{Emoji_Keycap_Sequence}", "v", "1\u{fe0f}\u{20e3}").0);
    }

    #[test]
    fn unicode_property_aliases_negation_and_ignore_case_execute() {
        assert!(caps("\\p{Letter}+", "u", "A\u{03B1}").0);
        assert!(caps("\\p{gc=Lu}", "u", "A").0);
        assert!(caps("\\p{sc=Grek}", "u", "\u{03B1}").0);
        assert!(caps("\\p{Script_Extensions=Hira}", "u", "\u{30FC}").0);
        assert!(caps("\\P{ASCII}", "u", "\u{00E9}").0);
        assert!(!caps("^\\P{Lowercase_Letter}$", "iu", "A").0);
        assert!(matches!(
            compile("\\p{letter}", "u"),
            Err(CompileError::Syntax(_))
        ));
    }

    // ---- compile-time accept/reject validation (the lexer's verdict) ----
    //
    // The ironhorse lexer rejects a regexp literal exactly when `compile`
    // returns `Syntax`; `Ok` and `Unsupported` both stand as accept (an
    // unported matcher surface whose syntax the oracle accepts). These
    // fixtures lock that verdict against the XS oracle for each class the
    // `language/literals/regexp` slice closed.

    /// The lexer's accept/reject verdict for a literal.
    fn accepts(pattern: &str, flags: &str) -> bool {
        !matches!(compile(pattern, flags), Err(CompileError::Syntax(_)))
    }

    #[test]
    fn reject_named_group_syntax() {
        // Ill-formed group names are SyntaxErrors (mxInvalidName).
        assert!(!accepts("(?<>a)", ""), "empty group name");
        assert!(!accepts("(?<42a>a)", ""), "name starts with a digit");
        assert!(!accepts("(?<:a>a)", ""), "punctuator-starting name");
        assert!(!accepts("(?<a:>a)", ""), "punctuator within name");
        assert!(!accepts("(?<aa)", ""), "unterminated groupspecifier");
        assert!(!accepts("(?<a\\>.)", ""), "escaped `>` is not id-continue");
        assert!(!accepts("(?<\u{2764}>a)", ""), "non-id-start (BMP symbol)");
        assert!(!accepts("(?<a\\uD801>.)", ""), "lone surrogate in name");
        assert!(!accepts("(?<a\\u{10FFFF}>.)", ""), "astral non-id in name");
    }

    #[test]
    fn reject_duplicate_and_dangling_names() {
        assert!(!accepts("(?<a>a)(?<a>a)", ""), "duplicate group name");
        assert!(!accepts("(?<a>.)\\k<b>", ""), "dangling \\k reference");
        assert!(!accepts("(?<a>a)\\k<ab>", ""), "dangling \\k reference (2)");
        assert!(!accepts("\\k<a>(?<b>x)", ""), "forward dangling reference");
        assert!(!accepts("(?<a>.)\\k<a", ""), "incomplete \\k name");
        assert!(!accepts("\\k<a>", "u"), "\\k with no group (u)");
    }

    #[test]
    fn inline_modifier_syntax_is_validated_and_executes() {
        // Valid inline modifiers now compile to a real program (they used to be
        // an honest Unsupported fold). An empty *remove* after `-` is legal.
        for pattern in ["(?i:a)", "(?im-s:a)", "(?-s:a)", "(?i-:a)", "(?ims-:a)"] {
            assert!(
                compile(pattern, "").is_ok(),
                "valid inline modifiers compile: {pattern}"
            );
        }
        for pattern in [
            "(?ii:a)",
            "(?i-i:a)",
            "(?-:a)", // both add and remove empty
            "(?g:a)",
            "(?\\u0069:a)",
            "(?i-a)",
            "(?i:a)+", // a modifier group is not itself quantifiable in XS
        ] {
            assert!(!accepts(pattern, ""), "invalid inline modifiers: {pattern}");
        }
        assert!(!accepts("(?i:(?<>a))", ""), "invalid nested group name");
        assert!(!accepts("(?i:a", ""), "unterminated modifier group");
    }

    #[test]
    fn inline_modifiers_scope_ignore_case_and_dot_all() {
        // `(?i:...)` folds only inside the group.
        assert!(caps("(?i:a)b", "", "Ab").0);
        assert!(!caps("(?i:a)b", "", "AB").0); // the trailing `b` stays case-sensitive
        // `(?-i:...)` removes folding inside an `i` pattern.
        assert!(caps("a(?-i:b)", "i", "Ab").0);
        assert!(!caps("a(?-i:b)", "i", "AB").0);
        // `(?s:.)` makes `.` match a newline only inside the group.
        assert!(caps("(?s:.)", "", "\n").0);
        assert!(!caps(".", "", "\n").0);
        // `(?m:^)` scopes multiline anchoring.
        assert!(caps("(?m:^b)", "", "a\nb").0);
        assert!(!caps("^b", "", "a\nb").0);
        // Nesting: an inner remove within an outer add restores case sensitivity.
        assert!(caps("(?i:a(?-i:b)c)", "", "AbC").0);
        assert!(!caps("(?i:a(?-i:b)c)", "", "ABC").0);
    }

    #[test]
    fn accept_wellformed_named_group() {
        // A syntactically valid named group / reference is accepted at
        // compile time (its matcher is a named Unsupported).
        assert!(accepts("(?<a>.)\\k<a>", ""), "matched named backreference");
        assert!(accepts("(?<name>x)", ""), "plain named group");
        // Non-`u` `\k` without a named group is an identity escape, not a
        // reference — accepted.
        assert!(accepts("\\k<a>", ""), "non-u \\k without group is literal");
    }

    #[test]
    fn reject_u_mode_syntax() {
        assert!(!accepts("{", "u"), "bare open-brace under u");
        assert!(!accepts("\\M", "u"), "identity escape under u");
        assert!(
            !accepts("(?<a>\\a)", "u"),
            "identity escape in named group (u)"
        );
        assert!(!accepts("\\u{110000}", "u"), "u code point out of range");
        assert!(!accepts("\\u{1,}", "u"), "u-escape non-hex");
        assert!(!accepts("\\u{1F_639}", "u"), "u-escape separator");
        assert!(!accepts("\\1", "u"), "\\1 backref with no group (u)");
        assert!(!accepts(".(?=.)?", "u"), "quantified lookahead (u)");
        // Valid u-mode escapes still stand (matcher is Unsupported).
        assert!(accepts("\\u{1F600}", "u"), "valid astral u-escape");
    }

    #[test]
    fn reject_non_u_assertion_and_flag_errors() {
        assert!(!accepts(".(?<=.)?", ""), "quantified lookbehind");
        assert!(!accepts(".", "gig"), "duplicate flag");
        assert!(!accepts(".", "G"), "invalid flag");
        assert!(!accepts("?", ""), "nothing to repeat");
        assert!(!accepts("{2}", ""), "quantifier with no atom");
    }

    // Annex-B legacy non-Unicode grammar & early-error parity with the XS pin
    // (`fxCompileRegExp`). XS is deliberately STRICTER than the ECMAScript
    // Annex-B leniency in several places; these fixtures lock ironhorse to XS's
    // actual verdict — not the spec's — since the differential bar is the pin.

    #[test]
    fn annexb_property_escape_is_unconditional() {
        // `\p{…}` / `\P{…}` are Unicode property escapes in EVERY mode. XS's
        // `fxCharSetParseEscape` dispatches `p`/`P` to `fxCharSetUnicodeProperty`
        // without consulting the `u`/`v` flag, so a legacy non-Unicode pattern
        // does NOT fall back to treating `\p` as an identity escape of `p`
        // (the ECMAScript Annex-B reading). An unknown or malformed property is
        // therefore a SyntaxError in non-Unicode mode too.
        for flags in ["", "i", "g", "m", "s", "y", "d", "u", "v"] {
            assert!(!accepts(r"\p{Foo}", flags), "unknown property /{flags}");
            assert!(!accepts(r"\p", flags), "bare \\p /{flags}");
            assert!(!accepts(r"\p{", flags), "unterminated \\p{{ /{flags}");
            assert!(!accepts(r"\pL", flags), "braceless \\pL /{flags}");
            assert!(!accepts(r"\P{Bar}", flags), "unknown \\P property /{flags}");
            // A valid general-category property compiles in every mode.
            assert!(accepts(r"\p{L}", flags), "valid \\p{{L}} /{flags}");
            assert!(accepts(r"[\p{Nd}]", flags), "valid class \\p{{Nd}} /{flags}");
        }
        // In non-Unicode mode a property escape is a real charset, not the two
        // literal characters `p{L}` — it must match a letter and reject `p`.
        assert!(caps(r"\p{L}", "", "A").0, "\\p{{L}} matches a letter (non-u)");
        assert!(!caps(r"\p{L}", "", "5").0, "\\p{{L}} rejects a digit (non-u)");
        assert!(!caps(r"\p{L}", "", "{").0, "\\p{{L}} is not literal p{{L}} (non-u)");
        // The v-mode string-property table stays gated on `v`.
        assert!(!accepts(r"\p{Emoji_Keycap_Sequence}", ""), "string prop only in v");
    }

    #[test]
    fn annexb_legacy_decimal_and_octal_escapes() {
        // XS reads a `\<digits>` term as a capture reference and rejects it when
        // the number exceeds the group count — it does NOT fall back to a legacy
        // octal/identity escape (Annex-B DecimalEscape leniency is not honored).
        assert!(!accepts(r"\1", ""), "\\1 with no group");
        assert!(!accepts(r"\8", ""), "\\8 with no group");
        assert!(!accepts(r"\9", ""), "\\9 with no group");
        assert!(!accepts(r"\12", ""), "\\12 greedily reads the whole number");
        assert!(!accepts(r"(a) \2", ""), "\\2 out of range");
        assert!(!accepts(r"\b(\w+) \2\b", ""), "forward \\2 out of range");
        assert!(accepts(r"(a)\1", ""), "\\1 in range");
        // `\a` is an identity escape (letter with no meaning) in non-Unicode.
        assert!(accepts(r"\a", ""), "\\a identity escape (non-u)");
        assert!(caps(r"\a", "", "a").0, "\\a matches literal a");
        // `\0` is NUL only when NOT followed by a decimal digit.
        assert!(accepts(r"\0", ""), "\\0 NUL");
        assert!(!accepts(r"\00", ""), "\\0 followed by a digit");
        assert!(!accepts(r"\07", ""), "legacy octal is not accepted");
    }

    #[test]
    fn annexb_control_escape_fallback_is_a_syntax_error() {
        // A `\c` NOT followed by an ASCII letter is `mxInvalidEscape` in XS in
        // every mode — XS does not implement the Annex-B "treat `\c` as literal
        // backslash" fallback.
        for flags in ["", "i", "u", "v"] {
            assert!(!accepts(r"\c", flags), "bare \\c /{flags}");
            assert!(!accepts(r"\c5", flags), "\\c + digit /{flags}");
            assert!(!accepts(r"\c_", flags), "\\c + underscore /{flags}");
            assert!(!accepts(r"[\c]", flags), "class \\c /{flags}");
            assert!(!accepts(r"[\c5]", flags), "class \\c + digit /{flags}");
        }
        // A valid control letter still resolves.
        assert!(accepts(r"\cA", ""), "\\cA control letter");
        assert!(caps(r"\cA", "", "\u{1}").0, "\\cA == U+0001");
    }

    #[test]
    fn annexb_class_range_and_malformed_boundaries() {
        // A class range whose endpoint is a class-escape (`\d`, `\w`) is a
        // SyntaxError (an "invalid range"), matching XS — even in non-Unicode.
        assert!(!accepts(r"[\d-a]", ""), "class-escape as range start");
        assert!(!accepts(r"[a-\d]", ""), "class-escape as range end");
        assert!(!accepts(r"[\d-\w]", ""), "class-escape on both ends");
        assert!(!accepts(r"[z-a]", ""), "reversed range");
        assert!(!accepts(r"[", ""), "unterminated class");
        // A legacy decimal escape as a range endpoint (`[\12-\14]`) is rejected
        // (the `\12` reads as an out-of-range reference, not an octal).
        assert!(!accepts(r"[\12-\14]", ""), "decimal-escape class range");
        // A `-` at an edge is a literal, not a range operator.
        assert!(accepts(r"[a-]", ""), "trailing dash literal");
        assert!(accepts(r"[-a]", ""), "leading dash literal");
        assert!(accepts(r"[\d-]", ""), "class escape then literal dash");
    }

    #[test]
    fn annexb_quantifiable_assertions_and_malformed_quantifiers() {
        // XS does NOT implement the ECMAScript Annex-B "QuantifiableAssertion"
        // leniency: a quantifier directly on ANY assertion — positive or
        // negative lookahead, either lookbehind, or a word boundary — is an
        // `mxInvalidCharacter` error in every mode (the `*`/`+`/`?` has nothing
        // to repeat). Locking XS's stricter reality, not the spec's.
        for flags in ["", "u", "v"] {
            assert!(!accepts(r"(?=x)*", flags), "quantified lookahead /{flags}");
            assert!(!accepts(r"(?!x)+", flags), "quantified neg-lookahead /{flags}");
            assert!(!accepts(r"(?<=x)*", flags), "quantified lookbehind /{flags}");
            assert!(!accepts(r"(?<!x)?", flags), "quantified neg-lookbehind /{flags}");
        }
        assert!(!accepts(r"\b*", ""), "quantified word boundary");
        // A bare, unquantified assertion is of course fine.
        assert!(accepts(r"(?=x)", ""), "plain lookahead");
        // A malformed `{…}` is a literal brace sequence in non-Unicode, but an
        // error under u/v.
        assert!(accepts(r"a{", ""), "bad brace is literal (non-u)");
        assert!(accepts(r"a{2", ""), "unterminated brace is literal (non-u)");
        assert!(!accepts(r"{2}", ""), "{{2}} with no atom is an error");
        assert!(!accepts(r"a{", "u"), "bad brace under u is an error");
        assert!(!accepts(r"a{2,1}", ""), "descending bounds");
        assert!(!accepts(r"a**", ""), "double quantifier");
    }
}
