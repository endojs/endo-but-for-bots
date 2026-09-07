//! Bounded-size guest source cannot abort the process: every recursion in
//! the compile pipeline is charged against a deterministic budget and refused
//! past it with a `SyntaxError` (`"stack overflow"`, XS's own
//! `fxCheckParserStack` wording) — the parser's nesting budget
//! ([`PARSER_STACK_BUDGET`]) for the recursive-descent frames, and the tree
//! depth limit ([`TREE_DEPTH_LIMIT`]) the parser enforces as it builds each
//! node, so that no tree deeper than it ever exists for the scoper, the
//! coder, the cover-grammar conversions or the drop glue to recurse over.
//!
//! Before the budget there was no guard anywhere in this crate: 4,000 nested
//! parentheses aborted an optimized build on an 8 MiB thread and 300 aborted
//! an unoptimized one, and a flat 100,000-term chain — about 200 KB of
//! `1+1+…` — aborted a 32 MiB thread merely being dropped. Now the boundary
//! is a property of the source. Each pin below is exact so a change to a
//! cost or to the recursion shape of a production is a visible contract
//! change.
//!
//! The at-limit *nested* sources need a few MiB of stack unoptimized (about
//! 35 KiB per cascade level), more than the 2 MiB default test thread, so
//! those cases run on a thread sized like the engine's own stack contract
//! (`ironhorse_vm::NATIVE_STACK_BYTES`). The over-limit flat chains run on
//! the default thread deliberately: with the tree-depth invariant they need
//! no deep recursion anywhere.

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
fn cascade_re_entry_is_bounded_at_about_ninety_levels() {
    // Every one of these re-enters the whole precedence cascade per level.
    pin("parentheses", |d| wrapped("(", "1", ")", d), 91);
    pin("array literals", |d| wrapped("[", "1", "]", d), 91);
    pin(
        "object literals",
        |d| format!("({})", wrapped("{a:", "1", "}", d)),
        90,
    );
    pin("call arguments", |d| wrapped("f(", "1", ")", d), 91);
    pin("arrow bodies", |d| wrapped("()=>", "1", "", d), 91);
    pin(
        "template substitutions",
        |d| wrapped("`${", "1", "}`", d),
        91,
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
    pin("if bodies", |d| wrapped("if(1) ", "1", "", d), 505);
    pin("new operands", |d| wrapped("new ", "f", "", d), 505);
    pin(
        "destructuring patterns",
        |d| format!("var {} = x", wrapped("[", "a", "]", d)),
        510,
    );
}

#[test]
fn operand_chains_are_bounded_at_about_a_thousand_levels() {
    // Right-recursive through `assignment_expression`, `unary_expression` or
    // `exponentiation_expression` alone: the cheapest frames, so the largest
    // allowance.
    pin("unary operators", |d| wrapped("!", "1", "", d), 1010);
    pin("conditional chains", |d| wrapped("a?b:", "1", "", d), 1011);
    pin("assignment chains", |d| wrapped("a=", "1", "", d), 1011);
    // `**` is right-associative and recurses in its own production, after
    // the charged operand production has returned.
    pin(
        "exponentiation chains",
        |d| wrapped("2**", "1", "", d),
        1011,
    );
}

#[test]
fn flat_chains_the_grammar_folds_into_deep_trees_are_bounded_by_the_tree_depth_limit() {
    // The parser never recurses for these (a loop folds each operand into a
    // left-nested node), so the source is "flat"; the tree is not, and the
    // node that would exceed the limit is refused as it is built.
    pin(
        "binary operator chains",
        |d| wrapped("1+", "1", "", d),
        2045,
    );
    pin("member chains", |d| format!("a{}", ".b".repeat(d)), 2045);
    pin("call chains", |d| format!("f{}", "()".repeat(d)), 2044);
    // An `else if` chain is parsed in a loop (`if_statement`), so it is a
    // flat shape whose right-nested `If` tree the depth limit bounds, not a
    // statement nest charged per branch.
    pin(
        "else-if chains",
        |d| format!("if (a) x; {}else y;", "else if (a) x; ".repeat(d)),
        2044,
    );
}

#[test]
fn a_flat_chain_is_refused_before_any_pass_can_recurse_over_it() {
    // A 100,000-term chain in every context that used to reach a recursive
    // helper or the drop glue with the whole tree already built: an object
    // literal (`duplicate_proto_setter_line`), an assignment target check,
    // a cover-grammar conversion, a class field, a `switch` case, a `for`
    // head. Runs on the default 2 MiB test thread on purpose: the refusal
    // happens at the node that would exceed the limit, so nothing deep is
    // ever built, walked, cloned or dropped.
    let chain = wrapped("1+", "1", "", 100_000);
    let contexts: [(&str, String); 14] = [
        ("bare", chain.clone()),
        ("assignment", format!("x = {chain}")),
        ("parenthesized", format!("({chain})")),
        ("array element", format!("[{chain}]")),
        ("object property", format!("({{a: {chain}}})")),
        (
            "__proto__ literal",
            format!("({{__proto__: null, a: {chain}, b: 2}})"),
        ),
        ("call argument", format!("f({chain})")),
        ("template substitution", format!("`${{{chain}}}`")),
        ("assignment pattern", format!("[a] = {chain}")),
        ("arrow default", format!("(a = {chain}) => 1")),
        (
            "strict binding",
            format!("\"use strict\"; var [a] = {chain};"),
        ),
        ("class field", format!("class A {{ x = {chain} }}")),
        ("switch case", format!("switch (1) {{ case {chain}: }}")),
        ("for head", format!("for (var i = {chain};;) break;")),
    ];
    for (name, source) in contexts {
        let result = compile(&source);
        assert!(
            is_stack_overflow(&result),
            "a 100,000-term chain as {name} must be refused, not aborted: {result:?}"
        );
    }
    // Flat *lists* are not chains: length alone is fine.
    let list: Vec<&str> = vec!["1"; 100_000];
    assert!(compile(&format!("[{}]", list.join(","))).is_ok());
    assert!(compile(&format!("({})", list.join(","))).is_ok());
    assert!(compile(&";".repeat(100_000)).is_ok());
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
        let inner_error = compile(&wrapped("(", "@", ")", 80));
        assert!(
            matches!(&inner_error, Err(e) if e.message != "stack overflow"),
            "the inner error wins: {inner_error:?}"
        );
        assert!(compile(&wrapped("(", "1", ")", 91)).is_ok());
    });
}
