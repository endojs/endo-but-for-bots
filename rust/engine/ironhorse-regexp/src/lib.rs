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
//! This increment ports the core grammar over the **non-`u`/`v`,
//! non-`i`** subset: literals, `.`, character classes (`[...]` with
//! ranges, negation, `\d\D\w\W\s\S`, control/hex/`\uXXXX` escapes),
//! anchors (`^ $ \b \B`), groups (capturing and `(?:...)`), quantifiers
//! (`* + ? {n,m}`, greedy and lazy), disjunction (`|`), numeric
//! backreferences (`\1`..), and lookaround (`(?=) (?!) (?<=) (?<!)`).
//! Every deferred surface is a **named** [`compile::CompileError::Unsupported`],
//! never a wrong meter or a wrong value: the `u`/`v` flags (CESU-8 surrogate
//! walk, unicode property escapes, V-mode string sets), `\p{}`/`\P{}`, inline
//! modifiers (`(?flags:)`), and astral (`> 0xFFFF`) code points. The `i` flag
//! (case folding) and named captures (`(?<name>)` / `\k<name>`) are ported.

mod charcase;
mod encoding;
mod flags;
mod opcode;

pub mod compile;
pub mod matcher;
pub mod unicode;

pub use compile::{compile, CompileError, Program};
pub use matcher::{match_regexp, MatchOutcome};
pub use flags::{
    XS_REGEXP_D, XS_REGEXP_G, XS_REGEXP_I, XS_REGEXP_M, XS_REGEXP_N, XS_REGEXP_S, XS_REGEXP_U,
    XS_REGEXP_V, XS_REGEXP_Y,
};

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
pub fn run(pattern: &str, flags: &str, subject: &str, start: i32) -> Result<RunOutcome, CompileError> {
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
    fn unsupported_u_flag_is_named() {
        match compile("abc", "u") {
            Err(CompileError::Unsupported(_)) => {}
            other => panic!("expected named Unsupported, got {:?}", other),
        }
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
        assert!(!accepts("(?<a>\\a)", "u"), "identity escape in named group (u)");
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
