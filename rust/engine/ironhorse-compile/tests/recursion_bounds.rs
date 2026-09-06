//! Bounded-size guest source cannot abort the process: every recursion in
//! the compile pipeline is charged against a deterministic budget and refused
//! past it with a `SyntaxError` (`"stack overflow"`, XS's own
//! `fxCheckParserStack` wording) — the parser's nesting budget
//! ([`PARSER_STACK_BUDGET`]) and the scoper's and coder's tree-depth limit
//! ([`TREE_DEPTH_LIMIT`]).
//!
//! Before the budget there was no guard anywhere in this crate: 4,000 nested
//! parentheses aborted an optimized build on an 8 MiB thread and 300 aborted
//! an unoptimized one, so whether a source compiled depended on the build
//! profile and on which thread ran the compiler. Now the boundary is a
//! property of the source. Each pin below is exact so a change to a cost or
//! to the recursion shape of a production is a visible contract change.
//!
//! The at-limit sources need a few MiB of stack unoptimized (about 35 KiB
//! per cascade level), more than the 2 MiB default test thread, so every
//! case runs on a thread sized like the engine's own stack contract
//! (`ironhorse_vm::NATIVE_STACK_BYTES`).

use ironhorse_compile::{compile, ParseError, ParseErrorKind};

fn on_engine_stack<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new()
        .stack_size(32 * 1024 * 1024)
        .spawn(f)
        .expect("spawn")
        .join()
        .expect("the compiler must return, never overflow")
}

fn is_stack_overflow(result: &Result<Vec<u8>, ParseError>) -> bool {
    matches!(
        result,
        Err(ParseError { kind: ParseErrorKind::Syntax, message, .. }) if message == "stack overflow"
    )
}

/// `open` × `depth`, `core`, `close` × `depth`.
fn wrapped(open: &str, core: &str, close: &str, depth: usize) -> String {
    format!("{}{core}{}", open.repeat(depth), close.repeat(depth))
}

/// Pin one shape: `ok` levels compile, `ok + 1` levels are the structured
/// refusal, and a far deeper nest is the same refusal (never an abort).
fn pin(name: &str, source: impl Fn(usize) -> String + Send + 'static, ok: usize) {
    let name = name.to_string();
    on_engine_stack(move || {
        let at = compile(&source(ok));
        assert!(
            at.is_ok(),
            "{name}: {ok} levels must compile: {:?}",
            at.err()
        );
        let past = compile(&source(ok + 1));
        assert!(
            is_stack_overflow(&past),
            "{name}: {} levels must be refused: {past:?}",
            ok + 1
        );
        let far = compile(&source(ok * 50));
        assert!(
            is_stack_overflow(&far),
            "{name}: {} levels must be refused: {far:?}",
            ok * 50
        );
    });
}

#[test]
fn cascade_re_entry_is_bounded_at_about_a_hundred_levels() {
    // Every one of these re-enters the whole precedence cascade per level.
    pin("parentheses", |d| wrapped("(", "1", ")", d), 101);
    pin("array literals", |d| wrapped("[", "1", "]", d), 101);
    pin(
        "object literals",
        |d| format!("({})", wrapped("{a:", "1", "}", d)),
        100,
    );
    pin("call arguments", |d| wrapped("f(", "1", ")", d), 101);
    pin("arrow bodies", |d| wrapped("()=>", "1", "", d), 101);
    pin(
        "template substitutions",
        |d| wrapped("`${", "1", "}`", d),
        101,
    );
}

#[test]
fn statement_nesting_is_bounded_at_512_levels() {
    pin("blocks", |d| wrapped("{", "", "}", d), 512);
    pin(
        "function bodies",
        |d| wrapped("function f(){", "", "}", d),
        512,
    );
    pin("if bodies", |d| wrapped("if(1) ", "1", "", d), 506);
    pin("new operands", |d| wrapped("new ", "f", "", d), 506);
    pin(
        "destructuring patterns",
        |d| format!("var {} = x", wrapped("[", "a", "]", d)),
        510,
    );
}

#[test]
fn operand_chains_are_bounded_at_about_a_thousand_levels() {
    // Right-recursive through `assignment_expression` / `unary_expression`
    // alone: the cheapest frames, so the largest allowance.
    pin("unary operators", |d| wrapped("!", "1", "", d), 1011);
    pin("conditional chains", |d| wrapped("a?b:", "1", "", d), 1012);
    pin("assignment chains", |d| wrapped("a=", "1", "", d), 1012);
}

#[test]
fn flat_chains_the_grammar_folds_into_deep_trees_are_bounded_by_the_tree_depth_limit() {
    // The parser never recurses for these (a loop folds each operand into a
    // left-nested node), so the source is "flat"; the tree is not, and the
    // scoper's walk is where the depth is refused.
    pin(
        "binary operator chains",
        |d| wrapped("1+", "1", "", d),
        2045,
    );
    pin("member chains", |d| format!("a{}", ".b".repeat(d)), 2045);
    pin(
        "exponentiation chains",
        |d| wrapped("2**", "1", "", d),
        2045,
    );
}

#[test]
fn a_regexp_literal_nested_past_the_pattern_limit_is_a_syntax_error() {
    // The lexer validates every regexp literal through `ironhorse_regexp`,
    // whose own nesting limit (`MAX_NESTING_DEPTH`, 512) bounds it; a
    // 10,000-deep group literal of about 20 KB used to abort from inside the
    // lexer.
    on_engine_stack(|| {
        assert!(compile(&format!("/{}/", wrapped("(", "a", ")", 512))).is_ok());
        let past = compile(&format!("/{}/", wrapped("(", "a", ")", 513)));
        assert!(
            matches!(
                &past,
                Err(ParseError {
                    kind: ParseErrorKind::Lex(_),
                    ..
                })
            ),
            "a too-deep regexp literal is a lex-time SyntaxError: {past:?}"
        );
        let far = compile(&format!("/{}/", wrapped("(", "a", ")", 10_000)));
        assert!(far.is_err(), "never an abort: {far:?}");
    });
}

#[test]
fn the_budget_is_released_on_the_error_path() {
    // A syntax error deep inside a nest propagates through every guarded
    // frame; the parser is single-use, so the observable is that the
    // refusal is the *inner* error, not a stale "stack overflow" from a
    // counter that was never released. And a second, independent compile of
    // an at-limit source still succeeds.
    on_engine_stack(|| {
        let inner_error = compile(&wrapped("(", "@", ")", 100));
        assert!(
            matches!(&inner_error, Err(e) if e.message != "stack overflow"),
            "the inner error wins: {inner_error:?}"
        );
        assert!(compile(&wrapped("(", "1", ")", 101)).is_ok());
    });
}
