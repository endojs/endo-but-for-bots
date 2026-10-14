//! A program the front end rejects throws XS's SyntaxError message, both at
//! the top level (`dual_run` presents the rejection) and under `eval`.
//!
//! `dual_run` turned every top-level rejection into a bare `SyntaxError`,
//! and three of the parser's messages left out what XS names: a regexp
//! literal's diagnostic (`( invalid sequence`, not `invalid regular
//! expression`), the binding in `duplicate variable a` and `duplicate
//! argument a`, and the token in `invalid token export`. The whole-tree
//! sweep recorded 369 such `error-message-differs` lines.

use ironhorse_262::dual_run;

const REJECTED: &[&str] = &[
    "a b",
    "if (1",
    "f(1",
    "var x = {a 1}",
    "x = [1, 2",
    "class { }",
    "switch (1) { case 1 }",
    "do 1; while",
    "try {}",
    "({ set a(b, c) {} })",
    "new.foo",
    "a?.b = 1",
    "1 = 2",
    "=> 1",
    "export default 1",
    "let a; let a;",
    "let a; var a;",
    "const b = 1; let b = 2;",
    "{ function f() {} let f; }",
    "function f(a, a) { 'use strict'; }",
    "(a, a) => 1",
    "class C { m(a, a) {} }",
    "label: label: 1",
    "'use strict'; function eval() {}",
    "/(/",
    "/a/gg",
    "/[b-a]/",
    "/(?<a>.)(?<a>.)/",
    "/\\k<b>(?<a>.)/u",
    "/a{2,1}/",
    "/\\p{Nope}/u",
];

#[test]
fn a_rejected_program_throws_xs_message_at_the_top_level() {
    for source in REJECTED {
        let run = dual_run(source).expect("the XS oracle machine must start");
        assert!(
            run.oracle_error.starts_with("SyntaxError"),
            "{source}: XS accepted it: {}",
            run.oracle_error
        );
        assert_eq!(run.ironhorse_error, run.oracle_error, "{source}");
    }
}

#[test]
fn a_rejected_eval_source_throws_xs_message() {
    for source in REJECTED {
        let program = format!(
            "try {{ eval({}); 'accepted' }} catch (e) {{ String(e) }}",
            js_quote(source)
        );
        let run = dual_run(&program).expect("the XS oracle machine must start");
        assert!(run.observables_agree(), "{program}: {run:?}");
    }
}

/// A JavaScript string literal for `text`.
fn js_quote(text: &str) -> String {
    let mut out = String::from("'");
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}
