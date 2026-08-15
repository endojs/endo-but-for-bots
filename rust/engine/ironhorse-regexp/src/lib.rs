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
//! behavior. Every remaining deferred surface is a **named**
//! [`compile::CompileError::Unsupported`], never a wrong meter or a wrong value:
//! inline modifiers (`(?flags:)`) and — outside `u`/`v`/a group name — an astral
//! code point in the pattern (which XS splits into surrogates, a path this stage
//! does not emit).

mod charcase;
mod encoding;
mod flags;
mod opcode;
mod unicode_property;

pub mod compile;
pub mod matcher;
pub mod unicode;

pub use compile::{compile, CompileError, Program};
pub use flags::{
    XS_REGEXP_D, XS_REGEXP_G, XS_REGEXP_I, XS_REGEXP_M, XS_REGEXP_N, XS_REGEXP_S, XS_REGEXP_U,
    XS_REGEXP_V, XS_REGEXP_Y,
};
pub use matcher::{match_regexp, MatchOutcome};

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
    fn inline_modifier_syntax_is_validated_before_the_named_fold() {
        for pattern in ["(?i:a)", "(?im-s:a)", "(?-s:a)"] {
            assert!(
                matches!(compile(pattern, ""), Err(CompileError::Unsupported(_))),
                "valid inline modifiers remain an honest matcher fold: {pattern}"
            );
        }
        for pattern in [
            "(?ii:a)",
            "(?i-i:a)",
            "(?-:a)",
            "(?i-:a)",
            "(?g:a)",
            "(?\\u0069:a)",
            "(?i-a)",
        ] {
            assert!(!accepts(pattern, ""), "invalid inline modifiers: {pattern}");
        }
        assert!(!accepts("(?i:(?<>a))", ""), "invalid nested group name");
        assert!(!accepts("(?i:a", ""), "unterminated modifier group");
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
}
