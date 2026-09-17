//! The compiler's totality, as far as it goes (architecture finding F063).
//!
//! F063's claim is that `ironhorse_compile::compile*` panics on valid ES2022
//! and on a spec early error, so a guest-triggerable fault is
//! indistinguishable from an unported construct. Two things follow from that,
//! and this file holds the part that can be held here.
//!
//! **What is closed.** The two sites the finding named by source text are
//! routed through the coder's error channel with an explicit KIND: a
//! CoverInitializedName used as an expression is `Syntax` (a spec early
//! error, and the guest sees a catchable `SyntaxError`), and a static block
//! with lexical declarations is `Unsupported` (a fold this compiler has not
//! ported, and an honest coverage gap). The classification now survives the
//! whole way out: `SourceCompileError::Invariant` reaches the VM as an
//! uncatchable `Halt::EngineInvariant`, and the test262 harness files a
//! caught panic under `compiler-panicked:<phase>` rather than sharing
//! `compiler-unimplemented:<phase>` with real coverage gaps, so
//! `XstReport::compiler_panics` can be — and is — asserted at zero over the
//! converted corpus.
//!
//! **What is NOT closed, and this file does not pretend otherwise.**
//! `coder.rs` still holds other `panic!` and `unreachable!` sites, and
//! `scoper.rs` a wider `expect`/`unwrap` surface. Their mere presence is not
//! proof that source text can reach them — most are invariants over the
//! parser's own output — but no audit has established that, so the compiler
//! is not total and the finding is not closed.
//!
//! **This roster is only as good as whoever wrote it, and that is not good
//! enough on its own.** It did not contain `for (let x, y in {})`, which
//! panicked, and which a reviewer found rather than a test. The gate that
//! does not depend on someone thinking of the shape is
//! `corpus_compiler_totality.rs`, which compiles every one of test262's
//! 53,575 sources and requires that none of them panics. This file is the
//! part that runs without a corpus, and the place to pin a shape once it is
//! known.

/// Compile under a firewall, reporting the outcome by its KIND.
///
/// The kind, not a three-way bucket. The first version folded everything
/// that was not `Unsupported` into `"rejected"`, which is the very
/// distinction this finding is about, collapsed inside its own test helper:
/// `ParseErrorKind` also has `MeterLimit` (a host stop that becomes an
/// UNCATCHABLE `MeterAbort`, not a `SyntaxError`) and `Lex`, so the
/// early-error roster below would have stayed green if the compiler started
/// answering `({a = 1});` with a budget refusal.
fn outcome(source: &str) -> Result<&'static str, String> {
    match std::panic::catch_unwind(|| ironhorse_compile::compile_atoms(source)) {
        Ok(Ok(_)) => Ok("compiled"),
        Ok(Err(error)) => Ok(match error.kind {
            ironhorse_compile::ParseErrorKind::Unsupported => "unsupported",
            ironhorse_compile::ParseErrorKind::Syntax => "syntax",
            ironhorse_compile::ParseErrorKind::MeterLimit => "meter-limit",
            ironhorse_compile::ParseErrorKind::Lex(_) => "lex",
        }),
        Err(_) => Err(format!("PANICKED on {source:?}")),
    }
}

/// The finding's own three probes, which used to panic.
#[test]
fn the_findings_probes_return_rather_than_panic() {
    for (source, expected) in [
        ("class C { static { let x = 1; } }", "unsupported"),
        ("({a = 1});", "syntax"),
        ("({a: {b = 1}});", "syntax"),
    ] {
        assert_eq!(outcome(source).expect(source), expected, "{source}");
    }
}

/// The two sites the F063 reachability AUDIT proved reachable, which the
/// 53,575-source corpus sweep could not reach.
///
/// The audit is the half of F063 the corpus floor is not: the sweep says the
/// compiler returns over one corpus, and the audit asks whether any source can
/// reach a given `panic!`. It swept ~1.28M generated sources across all five
/// goal/strictness modes and found exactly these two.
///
/// The first is the worse one, and is why "no panic over test262" was never
/// the same claim as "total": `try{}catch{function f(){}}` is twenty-six bytes
/// of unambiguously valid ES2022 and it aborted the compiler under EVERY goal.
/// `code_catch` coded its body's defines through the asserting
/// `scope_code_define_nodes`, whose contract is that the scope has none, where
/// `code_block` uses the real `code_define_nodes`. test262 holds exactly one
/// function-declaration-in-catch case and it is a `negative: parse` fixture,
/// so the parser rejects it before the coder ever runs — the one case that
/// would have caught this is the one that cannot.
///
/// The second is a goal asymmetry: `code_module` hoists its defines before
/// installing a return target, where `code_program` installs one first, so a
/// module-top-level `async function f(a = await 0){}` coded an `Await` with no
/// target. Per spec that is an early error (FormalParameters may not contain
/// an AwaitExpression), so reporting it is also the right ANSWER, not merely a
/// non-fatal one.
#[test]
fn the_audits_reachable_panics_return_rather_than_panic() {
    // Valid: a function declaration in a catch body, in each shape that
    // reached the assert. The last two are CONTROLS — a lexical declaration
    // and a class never reached it — so a fix that over-rejected would show
    // up here rather than only in the shapes that were broken.
    for source in [
        "try{}catch{function f(){}}",
        "try{}catch(e){function f(){}}",
        "'use strict';try{}catch{function f(){}}",
        "try{}catch{async function f(){}}",
        "try{}catch{function* f(){}}",
        "try{}catch{let x = 1;}",
        "try{}catch{class C{}}",
    ] {
        assert_eq!(outcome(source).expect(source), "compiled", "{source}");
    }
    let compiled = |source: &str, goal, strict| match std::panic::catch_unwind(|| {
        ironhorse_compile::compile_atoms_goal(source, goal, strict)
    }) {
        Ok(Ok(_)) => "compiled".to_string(),
        Ok(Err(e)) => format!("{:?}:{}", e.kind, e.message),
        Err(_) => panic!("PANICKED on {source:?}"),
    };
    // `await` in an async function's own parameter list is a spec early
    // error, and the fix is only worth anything if it holds under EVERY
    // goal. The audit found it as a module-goal PANIC, but the panic was one
    // goal's symptom: under the other three the same source compiled into a
    // function whose body silently never ran, which is the wrong answer the
    // roster above exists to refuse.
    for (goal, strict) in [
        (ironhorse_compile::Goal::Script, false),
        (ironhorse_compile::Goal::Module, false),
        (ironhorse_compile::Goal::Eval, false),
        (ironhorse_compile::Goal::Eval, true),
    ] {
        for source in [
            "async function f(a=await 0){}",
            "(async function (a=await 0){})",
        ] {
            assert_eq!(
                compiled(source, goal, strict),
                "Syntax:invalid await",
                "{source} under {goal:?} strict={strict}"
            );
        }
        // And the generator twin, which the same parser rule refuses.
        assert_eq!(
            compiled("function* g(a=yield 0){}", goal, strict),
            "Syntax:invalid yield",
            "yield in generator params under {goal:?}"
        );
    }
    // The features themselves still work: the rule must reject a parameter
    // list, not the construct.
    let module = |s: &str| compiled(s, ironhorse_compile::Goal::Module, false);
    assert_eq!(module("await 0;"), "compiled");
    assert_eq!(module("async function f(){ await 0; }"), "compiled");
    assert_eq!(module("function* g(){ yield 0; }"), "compiled");
    assert_eq!(module("async function f(a=1){ await a; }"), "compiled");
    // The over-rejection controls that matter: a NESTED async or generator
    // function inside a parameter default owns its own `await`/`yield`, and
    // the rule must not see through it. These are the cases a flag that
    // leaked across the nested function's scope would break.
    for source in [
        "async function f(a = async function(){ await 0; }) {}",
        "function* g(a = function*(){ yield 1; }) {}",
        "function* g(a = async function(){ await 0; }) {}",
        "async function f(a = function*(){ yield 1; }) {}",
        "async function* ag(a = 1) { yield a; await a; }",
        "class C { async m(a = 1) { await a; } }",
    ] {
        assert_eq!(module(source), "compiled", "{source}");
    }
}

/// Valid ES2022 that must COMPILE. A fold that grew to swallow one of these
/// would trade a panic for a wrong answer, which is worse.
#[test]
fn valid_es2022_compiles() {
    for source in [
        // The shapes adjacent to the two converted folds, which must not
        // have widened.
        "[a = 1];",
        "({ a = 1 } = {});",
        "var { a = 1 } = {};",
        "[{ a = 1 }] = [{}];",
        "function f({ a = 1 } = {}) { return a; }",
        "class D { f = 1; }",
        "class E { static { 1; } }",
        "class F { static { this.x = 1; } }",
        "class G { #p = 1; get p() { return this.#p; } }",
        // A spread of the language the compiler claims.
        "class H extends Object { constructor() { super(); } }",
        "async function a() { for await (const x of []) { x; } }",
        "function* g() { yield* []; }",
        "async function* ag() { yield 1; }",
        "label: for (const x of []) { continue label; }",
        "try { 1; } catch { 2; } finally { 3; }",
        "const { a, ...rest } = { a: 1, b: 2 };",
        "const [x, , y = 2, ...z] = [1, 2];",
        "(a = 1, ...b) => a;",
        "function f2() { new.target; }",
        "a?.b?.[c]?.(d);",
        "x ??= 1; y ||= 2; z &&= 3;",
        "1_000n ** 2n;",
        "/(?<n>a)\\k<n>/u.exec('aa');",
        "`a${1}b${`c${2}`}`;",
        "({ get a() { return 1; }, set a(v) {}, [1]: 2, ...{} });",
        "with (Object) { keys; }",
        "switch (1) { case 1: break; default: }",
        "do { 1; } while (0);",
        "for (var i = 0, j = 1; i < j; i++, j--) {}",
        "delete globalThis.x; void 0; typeof undeclared;",
    ] {
        let what = outcome(source).expect(source);
        assert_eq!(what, "compiled", "{source} came back {what}");
    }
}

/// Spec early errors must be a `Syntax` rejection: not folded to a coverage
/// gap, not a host stop, not fatal. A fold here would report a real early
/// error as missing coverage, which is the classification failure F063 is
/// about, pointed the other way — and `MeterLimit` would turn a catchable
/// `SyntaxError` into an uncatchable `MeterAbort`, the same failure pointed a
/// third way.
#[test]
fn spec_early_errors_are_rejected() {
    for source in [
        "({a = 1});",
        "class C { static { arguments; } }",
        "class C { static { await 1; } }",
        "'use strict'; with (x) {}",
        "let x; let x;",
        "const c;",
        "for (let x of []) { let x; var x; }",
        "function f() { break; }",
        "return 1;",
        "class C { constructor() {} constructor() {} }",
        "({ a(){ super(); } });",
        "0++;",
        "'use strict'; delete x;",
        // A for-in/of head declares exactly one binding. All five of these
        // PANICKED the coder, and two sit in test262 as
        // `language/block-scope/syntax/for-in/disallow-multiple-lexical-*`,
        // recorded in the committed expectations as a coverage gap. The
        // roster did not have them; a reviewer did.
        "for (let x, y in {}) { }",
        "for (let x, y of []) { }",
        "for (const x, y in {}) { }",
        "for (var x, y in {}) { }",
        "for (let x = 1, y in {}) { }",
    ] {
        let what = outcome(source).expect(source);
        assert_eq!(what, "syntax", "{source} came back {what}");
    }
}

/// Adversarial but well-formed shapes: deep nesting, wide literals, the
/// boundaries a fuzzer reaches slowly. None may panic; each may compile or
/// report.
#[test]
fn adversarial_shapes_return_rather_than_panic() {
    let mut sources = vec![
        "(".repeat(64) + "1" + &")".repeat(64) + ";",
        "[".repeat(64) + &"]".repeat(64) + ";",
        format!("var a = [{}];", "1,".repeat(2_000)),
        format!("({});", "a,".repeat(500) + "1"),
        format!("{}1;", "!".repeat(200)),
        format!(
            "var o = {{{}}};",
            (0..500).map(|i| format!("k{i}:{i},")).collect::<String>()
        ),
        format!("{}{}", "if(1)".repeat(64), "1;"),
        format!("function f() {{ {} }}", "return 1;".repeat(1_000)),
    ];
    // Lone surrogates and astral text in source positions, which the
    // UTF-8/UTF-16 boundary makes interesting.
    sources.push("var s = '\\ud800'; s;".to_string());
    sources.push("var s = '\\ud83d\\ude00'; s.length;".to_string());
    sources.push("var \\u0061 = 1; a;".to_string());
    sources.push("/\\ud800/u;".to_string());

    for source in &sources {
        outcome(source).expect("a well-formed shape must not panic the compiler");
    }
}

/// Malformed input must be REJECTED, never fatal. The parser has its own
/// fuzz target for this; the point here is that the CODER, which runs after
/// a successful parse, is reached by nothing it cannot handle.
///
/// Asserted, not merely survived: the first version called `outcome` and
/// discarded the answer, so `"compiled"` passed a test named
/// `..._is_rejected_...`. Two of its twenty-three entries were in fact valid
/// programs that compiled cleanly — `await` (an ordinary sloppy-script
/// identifier) and a lone U+FEFF (whitespace) — and it reported neither.
/// They are in [`odd_but_well_formed_input_compiles`] now, where they belong.
#[test]
fn malformed_input_is_rejected_rather_than_fatal() {
    for source in [
        "(",
        ")",
        "{",
        "}",
        "[",
        "]",
        "var",
        "function",
        "class",
        "=>",
        "...",
        "?.",
        "'unterminated",
        "/unterminated",
        "0x",
        "1e",
        "1n.2",
        "a b c",
        "#x",
        "\\u{110000}",
        "\0",
    ] {
        // `expect` reports the source that panicked, which is the only thing
        // a reader needs.
        let what = outcome(source).expect("malformed input must not panic the compiler");
        assert!(
            what == "syntax" || what == "lex",
            "{source:?} is malformed but came back {what}"
        );
    }
}

/// Input that is odd but WELL-FORMED, kept apart from the malformed roster so
/// neither list can quietly absorb the other: `await` is an ordinary
/// sloppy-script identifier, and a lone U+FEFF is whitespace, so both are
/// complete programs. They sat in the malformed roster above, under a test
/// that asserted nothing about the answer.
#[test]
fn odd_but_well_formed_input_compiles() {
    for source in ["await", "\u{feff}"] {
        let what = outcome(source).expect("well-formed input must not panic the compiler");
        assert_eq!(what, "compiled", "{source:?} came back {what}");
    }
}

/// The firewall's own arm, exercised: a panic under
/// `compile_atoms_budgeted_firewalled` comes back as
/// `CompileError::Invariant`, not as a parse reject and not as a process
/// abort.
///
/// There is no source string known to panic today's coder — establishing
/// one is the open half of this finding — so the panic is injected through
/// the one caller-supplied callback a compile runs: the charge admission
/// hook. It travels the path a coder `panic!` would, past `catch_refusal`
/// (which resumes anything that is not the meter's own private refusal
/// payload) and into the firewall.
///
/// That the injection point is the CALLER's closure is also the firewall's
/// one honest limitation, asserted rather than hidden: it cannot tell a
/// panic raised inside the compiler from one raised inside the callback the
/// compiler invoked, and classifies both as an engine fault. Neither is a
/// coverage gap and neither is a guest error, so the classification is not
/// wrong — but an embedder whose charge hook panics will read
/// `eval:compiler-invariant` and should look at its own hook first.
#[test]
fn a_panic_under_the_firewall_is_classified_as_an_invariant() {
    let mut charged = 0u32;
    let mut charge = |_: u64| -> bool {
        charged += 1;
        panic!("INJECTED-COMPILER-FAULT");
    };
    let error = ironhorse_compile::compile_atoms_budgeted_firewalled(
        "var a = 1; a + 1;",
        ironhorse_compile::Goal::Eval,
        false,
        u64::MAX,
        &mut charge,
    );
    let error = match error {
        Ok(_) => panic!("an injected panic must not be reported as a successful compile"),
        Err(error) => error,
    };
    match error {
        ironhorse_compile::CompileError::Invariant(detail) => assert!(
            detail.contains("INJECTED-COMPILER-FAULT"),
            "the classification kept the wrong payload: {detail:?}"
        ),
        other => panic!("a caught panic must classify as Invariant, got {other:?}"),
    }
}

/// Meter refusal travels the same firewall and is NOT an invariant
/// violation: a host that stops the compiler must not be accused of
/// breaking it. Without this, classifying every caught panic as a fault
/// would make an ordinary budget stop look like an engine bug.
#[test]
fn meter_refusal_under_the_firewall_is_still_a_refusal() {
    let mut charge = |_: u64| -> bool { false };
    let error = ironhorse_compile::compile_atoms_budgeted_firewalled(
        "var a = 1; a + 1;",
        ironhorse_compile::Goal::Eval,
        false,
        u64::MAX,
        &mut charge,
    );
    let error = match error {
        Ok(_) => panic!("a refusing host must stop the compile"),
        Err(error) => error,
    };
    assert!(
        matches!(error, ironhorse_compile::CompileError::MeterAbort),
        "budget refusal classified as {error:?}"
    );
}

/// A parse reject travels the firewall unchanged, and a valid program still
/// compiles through it. The firewall is a classification, not a filter.
#[test]
fn the_firewall_does_not_disturb_the_ordinary_outcomes() {
    let mut charge = |_: u64| -> bool { true };
    let ok = ironhorse_compile::compile_atoms_budgeted_firewalled(
        "var a = 1; a + 1;",
        ironhorse_compile::Goal::Eval,
        false,
        u64::MAX,
        &mut charge,
    );
    assert!(
        ok.is_ok(),
        "a valid program must compile through the firewall"
    );

    let rejected = ironhorse_compile::compile_atoms_budgeted_firewalled(
        "({a = 1});",
        ironhorse_compile::Goal::Eval,
        false,
        u64::MAX,
        &mut charge,
    );
    let rejected = match rejected {
        Ok(_) => panic!("a CoverInitializedName expression is an early error"),
        Err(error) => error,
    };
    assert!(
        matches!(rejected, ironhorse_compile::CompileError::Parse(_)),
        "an early error classified as {rejected:?}"
    );
}
