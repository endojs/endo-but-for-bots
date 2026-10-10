//! `ironhorse-xst` must not report an engine gap as `SyntaxError`.
//!
//! The host prints `Name: message` to stderr and `eshost` matches the name, so
//! a test262 case carrying `negative: { phase: parse, type: SyntaxError }`
//! PASSES on that name alone. Reporting an unported construct or an exhausted
//! allowance under it would credit the ratchet for our own shortfall, which is
//! the opposite of what the ratchet measures.
//!
//! These lists are LITERAL, so they pin today's sixteen `LexErrorKind`
//! variants and would not notice a seventeenth. That is deliberate: the
//! guard against a new variant is the match in `compile_failure_name`
//! itself, which names all sixteen with no wildcard, so adding one is a
//! compile error there rather than a silently-credited pass here.

use ironhorse_262::compile_failure_name;
use ironhorse_compile::{LexError, LexErrorKind, ParseError, ParseErrorKind};

fn named(kind: ParseErrorKind) -> &'static str {
    compile_failure_name(&ParseError {
        line: 1,
        kind,
        message: "irrelevant".into(),
    })
}

fn lex(kind: LexErrorKind) -> &'static str {
    named(ParseErrorKind::Lex(LexError { line: 1, kind }))
}

#[test]
fn an_engine_gap_never_claims_syntax_error() {
    // "Valid JS we have not ported" is the whole point of the finding.
    assert_eq!(named(ParseErrorKind::Unsupported), "InternalError");
    // Its own doc says "not a SyntaxError".
    assert_eq!(named(ParseErrorKind::MeterLimit), "InternalError");
    for kind in [
        LexErrorKind::MeterLimit,
        LexErrorKind::RegExpBudgetExceeded,
        LexErrorKind::RegExpResourceLimit,
        LexErrorKind::Overflow,
    ] {
        assert_eq!(lex(kind.clone()), "InternalError", "{kind:?}");
    }
}

#[test]
fn a_real_early_error_still_reports_syntax_error() {
    assert_eq!(named(ParseErrorKind::Syntax), "SyntaxError");
    // Every lex kind that IS the grammar rejecting the source.
    for kind in [
        LexErrorKind::UnterminatedString,
        LexErrorKind::LineTerminatorInString,
        LexErrorKind::UnterminatedComment,
        LexErrorKind::UnterminatedRegExp,
        LexErrorKind::LineTerminatorInRegExp,
        LexErrorKind::InvalidRegExp,
        LexErrorKind::InvalidNumber,
        LexErrorKind::InvalidEscape,
        LexErrorKind::StrictOctal,
        LexErrorKind::InvalidAtSign,
        LexErrorKind::InvalidCharacter(0),
        LexErrorKind::UnexpectedCharacter(0),
    ] {
        assert_eq!(lex(kind.clone()), "SyntaxError", "{kind:?}");
    }
}

/// Through the real front end rather than a synthesized kind, so the mapping
/// is pinned against what the compiler actually returns.
#[test]
fn sources_the_grammar_rejects_report_syntax_error() {
    for source in [
        "var x = 'unterminated",
        "var x = /* unterminated",
        "var x = 0b2;",
        "var x = ;",
    ] {
        let error =
            ironhorse_compile::compile_atoms_goal(source, ironhorse_compile::Goal::Script, false)
                .expect_err(source);
        assert_eq!(
            compile_failure_name(&error),
            "SyntaxError",
            "{source}: {error} ({:?})",
            error.kind
        );
    }
}

/// A source the grammar accepts must not reach the classifier at all.
#[test]
fn accepted_sources_do_not_fail_to_compile() {
    ironhorse_262::run_script_source("var x = 1 + 1;").expect("accepted");
}
