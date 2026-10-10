//! Native lockdown is host setup, outside the subject's lexical and parse scope.
use ironhorse_262::{
    dual_run_scripts,
    xst::{run_case, Config, SesMode, Verdict},
    Agreement, IronhorseCompile,
};
use std::path::PathBuf;

fn harness() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/test262-runner/test262/harness")
}

fn locked_config() -> Config {
    Config {
        ses_mode: SesMode::Lockdown,
        repeat: 2,
        ..Config::default()
    }
}

fn assert_covered(cfg: &Config, source: &str) {
    let result = run_case(cfg, &harness(), source);
    assert_eq!(result.verdict, Verdict::Covered, "{source}\n{result:?}");
    assert!(!result.strict_skipped);
}

#[test]
fn raw_corpus_files_keep_their_hashbang_and_directive_prologues() {
    // Reuse the original files that concatenating `lockdown();` corrupted.
    let corpus = harness().parent().unwrap().join("test/language");
    for path in [
        "comments/hashbang/use-strict.js",
        "directive-prologue/10.1.1-2gs.js",
        "directive-prologue/10.1.1-5gs.js",
        "directive-prologue/10.1.1-8gs.js",
        "directive-prologue/14.1-4gs.js",
        "directive-prologue/14.1-5gs.js",
    ] {
        let source = std::fs::read_to_string(corpus.join(path)).expect("committed corpus");
        assert_covered(&locked_config(), &source);
    }
}

#[test]
fn case_declarations_cannot_hijack_the_setup_lockdown() {
    for declaration in ["function lockdown() {}", "let lockdown = () => {};"] {
        for flags in ["raw", "onlyStrict", "module, raw"] {
            let source = format!(
                "/*---\nflags: [{flags}]\n---*/\n{declaration}\n\
                 if (!Object.isFrozen(Object.prototype)) throw 'lockdown bypassed';\n\
                 if (Function.prototype.constructor === Function) throw 'live evaluator';"
            );
            assert_covered(&locked_config(), &source);
        }
    }
}

#[test]
fn async_subjects_retain_their_requested_strictness() {
    for cfg in [Config::default(), locked_config()] {
        assert_covered(
            &cfg,
            "/*---\nflags: [async, onlyStrict]\n---*/\n\
             const receiver = (function() { return this; })();\n\
             $DONE(receiver === undefined ? undefined : new Error('strict mode lost'));",
        );
    }
}

#[test]
fn setup_and_subject_share_one_final_job_checkpoint() {
    let runs = dual_run_scripts(&[
        "globalThis.order = 'setup'; Promise.resolve().then(() => { order += ':job'; }); void 0;",
        "if (order !== 'setup') throw 'premature checkpoint'; order += ':subject';\n\
         Promise.resolve().then(() => { globalThis.signal = order; }); void 0;",
    ], Some("signal")).expect("oracle");
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0].ironhorse_signal, None);
    assert_eq!(
        runs[1].ironhorse_signal.as_deref(),
        Some("setup:subject:job")
    );
    for phase in runs {
        assert_eq!(
            phase.run.agreement,
            Agreement::BothComplete,
            "{:?}",
            phase.run
        );
        assert_eq!(phase.run.ironhorse_compile, IronhorseCompile::Accepted);
    }
}

#[test]
fn setup_precedes_module_body_without_entering_its_scope() {
    let mut cfg = locked_config();
    cfg.prelude = Some(
        "globalThis.setupOrder = 'setup';\n\
         Promise.resolve().then(() => { setupOrder += ':job'; });"
            .into(),
    );
    assert_covered(
        &cfg,
        "/*---\nflags: [module]\n---*/\n\
         const lockdown = () => { throw 'wrong lockdown'; };\n\
         assert.sameValue(Object.isFrozen(Object.prototype), true);\n\
         globalThis.result = setupOrder;",
    );
}

#[test]
fn setup_errors_cannot_satisfy_a_negative_case() {
    for flags in ["onlyStrict", "async, onlyStrict", "module"] {
        for (phase, ty, body) in [
            (
                "runtime",
                "TypeError",
                "throw new TypeError('subject failure');",
            ),
            ("parse", "SyntaxError", "const = ;"),
        ] {
            for prelude in ["throw new TypeError('setup failure');", "const = ;"] {
                let mut cfg = locked_config();
                cfg.prelude = Some(prelude.into());
                let source = format!(
                    "/*---\nflags: [{flags}]\nnegative:\n  phase: {phase}\n  type: {ty}\n---*/\n{body}"
                );
                let result = run_case(&cfg, &harness(), &source);
                assert!(
                    matches!(result.verdict, Verdict::Fail(ref reason) if reason.starts_with("setup failed:")),
                    "{result:?}"
                );
            }
        }
    }
}
