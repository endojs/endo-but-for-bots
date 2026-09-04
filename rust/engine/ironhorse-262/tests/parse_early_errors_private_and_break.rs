//! Parse-phase early-error coverage for two front-end gaps the
//! `parse-or-decode` / compiler-unimplemented milestone closed:
//!
//!   * **`AllPrivateNamesValid`** — a private-name reference (`this.#x`,
//!     `obj.#m()`, `#f in obj`) that resolves to no enclosing class is a
//!     parse-phase `SyntaxError`. `ironhorse-compile` already rejected these in
//!     sloppy mode, but the strict eval-goal scope synthesized a brand declare
//!     (mirroring XS's `fxScopeLookup`) and then *panicked* in the coder
//!     (`assert_declared_kind`), reporting `strict:compiler-unimplemented:parse`.
//!     The static oracle-shim compile has no enclosing private environment, so
//!     the synthesized brand can never resolve — the reference is the early
//!     error, and ironhorse now reports it as one in both modes.
//!
//!   * **`invalid break` / `invalid continue`** — a `break`/`continue` with no
//!     enclosing target (bare, in a function, or in a `static { … }` block) is a
//!     code-time `fxReportParserError` in XS. ironhorse previously `panic!`ed
//!     (`compiler-unimplemented:parse`); it now records the structured
//!     SyntaxError, matching XS.
//!
//! Both engines reject at parse; XS represents that with a bytecode stub that
//! throws `SyntaxError` (for the strict private cases, a deferred runtime
//! `SyntaxError`), so the differential must see two agreeing SyntaxError
//! rejections and cover the case.

use ironhorse_262::{dual_run, Agreement, IronhorseCompile};

/// Assert `source` is a covered parse-phase rejection: ironhorse's own front
/// end returns a structured `Rejected` (never `Unsupported`/`Panicked`), both
/// engines abort, and ironhorse presents the bare `SyntaxError` the oracle does.
/// This is exactly what `evaluate_negative_early` reads to mark a parse-phase
/// negative `Covered` (ironhorse `Rejected` + an oracle parse rejection). The
/// oracle's descriptive message (`SyntaxError: invalid private identifier`,
/// or a strict deferred `SyntaxError: eval #x: undefined private property`) is
/// its own SyntaxError constructor, so full-string `error_agrees` is *not*
/// required — only that both are SyntaxError aborts.
fn covered_syntax_error_rejection(source: &str) {
    let run = dual_run(source).expect("the pinned XS oracle machine must start");
    assert!(
        matches!(run.ironhorse_compile, IronhorseCompile::Rejected(_)),
        "{source}: ironhorse-compile must cleanly reject (not panic / decline): {:?}",
        run.ironhorse_compile
    );
    assert_eq!(
        run.agreement,
        Agreement::BothAbort,
        "{source}: expected both engines to reject at parse: {run:?}"
    );
    assert_eq!(
        run.ironhorse_error, "SyntaxError",
        "{source}: ironhorse must throw a SyntaxError: {run:?}"
    );
    assert!(
        run.oracle_error.starts_with("SyntaxError"),
        "{source}: the oracle must also reject with a SyntaxError: {run:?}"
    );
}

#[test]
fn unresolved_private_name_is_covered_early_error_sloppy_and_strict() {
    for body in [
        "this.#x",
        "({}).#x",
        "this.#m()",
        "#x in {}",
        "class C { f = this.#x }",
        "class C { m() { return this.#x; } }",
        "class C extends this.#x {}",
    ] {
        covered_syntax_error_rejection(body);
        covered_syntax_error_rejection(&format!("\"use strict\";\n{body}"));
    }
}

#[test]
fn invalid_break_continue_is_covered_early_error() {
    for body in [
        "break;",
        "continue;",
        "break foo;",
        "continue foo;",
        "{ break; }",
        "function f() { break; }",
        "class C { static { break; } }",
        "class C { static { continue; } }",
    ] {
        covered_syntax_error_rejection(body);
        covered_syntax_error_rejection(&format!("\"use strict\";\n{body}"));
    }
}
