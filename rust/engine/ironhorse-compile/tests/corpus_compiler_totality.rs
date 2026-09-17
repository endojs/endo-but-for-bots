//! The compiler is total over the authoritative test262 corpus
//! (architecture finding F063).
//!
//! F063's claim is that `ironhorse_compile::compile*` panics on valid ES2022
//! and on a spec early error, so a guest-triggerable fault is
//! indistinguishable from an unported construct. `compiler_totality.rs`
//! answers that with a hand-written roster, which is worth having and is
//! also exactly as good as whoever wrote it: the roster did not contain
//! `for (let x, y in {})`, which panicked, sat in the committed test262
//! expectations as `skip:compiler-unimplemented:parse`, and was found by a
//! reviewer rather than by a test.
//!
//! This is the gate that does not depend on someone thinking of the shape:
//! compile **every** `.js` file in test262 and require that none of them
//! panics. No oracle, no VM, no harness assembly — a file is read and handed
//! to the compiler, and the only question asked is whether it returns.
//!
//! **What it does not check.** Not whether the compiler's ANSWER is right:
//! a file that should be a SyntaxError and compiles cleanly passes here.
//! That is the 262 harness's job and it has the oracle to do it with. This
//! asks the one question that needs no oracle and that the rest of the suite
//! cannot ask cheaply.
//!
//! **Where it runs.** It needs the corpus, which is not in the repository, so
//! it returns early when there is none — with one exception:
//! `IRONHORSE_COMPILER_TOTALITY_REQUIRED=1` makes a missing corpus a failure,
//! which is what CI sets on the lane that vendors test262. Without that,
//! an early return is a green test that measured nothing, which is the trap
//! `ci.yml` already documents for the SES bundles.
//!
//! Point it at a checkout with `TEST262_DIR`, or leave it to find the one
//! `scripts/full-run.sh` vendors under `target/test262-report/test262-src`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Where the corpus might be, in order: an explicit `TEST262_DIR`, then the
/// checkout `scripts/full-run.sh` vendors.
fn corpus() -> Option<PathBuf> {
    let candidates = [
        std::env::var_os("TEST262_DIR").map(PathBuf::from),
        Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/test262-report/test262-src")),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|dir| dir.join("harness/sta.js").is_file() && dir.join("test").is_dir())
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, out);
        } else if path.extension().is_some_and(|e| e == "js") {
            // A `_FIXTURE.js` is a module another case imports, never a case.
            if !path.to_string_lossy().ends_with("_FIXTURE.js") {
                out.push(path);
            }
        }
    }
}

/// The corpus is large enough that a wrong root (an empty directory, a
/// partial clone) must not read as "swept everything, found nothing".
const MIN_CASES: usize = 40_000;

#[test]
fn the_compiler_does_not_panic_on_any_test262_source() {
    let Some(root) = corpus() else {
        assert!(
            std::env::var("IRONHORSE_COMPILER_TOTALITY_REQUIRED").as_deref() != Ok("1"),
            "IRONHORSE_COMPILER_TOTALITY_REQUIRED=1 but no test262 checkout was \
             found. Set TEST262_DIR to a root holding `harness/sta.js` and \
             `test/`, or run `ironhorse-262/scripts/full-run.sh` once to vendor \
             one at the pinned SHA."
        );
        eprintln!(
            "corpus_compiler_totality: no test262 checkout; set TEST262_DIR. \
             This run measured nothing."
        );
        return;
    };

    let mut files = Vec::new();
    collect(&root.join("test"), &mut files);
    files.sort();
    assert!(
        files.len() >= MIN_CASES,
        "only {} case(s) under {}: that is not the test262 corpus, and a \
         sweep over the wrong root proves nothing",
        files.len(),
        root.display()
    );

    // A panic here is the expected outcome under test, not a crash to report:
    // silence the hook so a failure reads as this test's message rather than
    // as thousands of backtraces.
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let mut panics: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut compiled = 0usize;
    for file in &files {
        let Ok(source) = std::fs::read_to_string(file) else {
            // A non-UTF-8 case is the reader's limitation, not the
            // compiler's; `utf16_source.rs` owns that boundary.
            continue;
        };
        // The goal only selects which grammar is parsed. A module case
        // compiled as a Script (or the reverse) would report an error, and an
        // error is a fine outcome here — the question is only whether the
        // compiler RETURNS. The `flags:` line is read so the common case is
        // the honest one.
        let goal = if source.contains("flags:") && source.contains("module") {
            ironhorse_compile::Goal::Module
        } else {
            ironhorse_compile::Goal::Script
        };
        let outcome = std::panic::catch_unwind(|| {
            ironhorse_compile::compile_atoms_goal(&source, goal, false)
        });
        match outcome {
            Ok(_) => compiled += 1,
            Err(payload) => {
                let message = payload
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
                    .unwrap_or_else(|| "non-string compiler panic".to_string());
                let key = message.lines().next().unwrap_or("?").to_string();
                panics.entry(key).or_default().push(
                    file.strip_prefix(&root)
                        .unwrap_or(file)
                        .to_string_lossy()
                        .to_string(),
                );
            }
        }
    }
    std::panic::set_hook(previous);

    let total: usize = panics.values().map(Vec::len).sum();
    if total > 0 {
        let mut detail = String::new();
        for (message, cases) in &panics {
            detail.push_str(&format!("\n  {} x {message}", cases.len()));
            for case in cases.iter().take(5) {
                detail.push_str(&format!("\n      {case}"));
            }
            if cases.len() > 5 {
                detail.push_str(&format!("\n      ... and {} more", cases.len() - 5));
            }
        }
        panic!(
            "the compiler panicked on {total} of {} test262 source(s), in {} \
             distinct place(s). Each one is an engine fault a guest can reach \
             by handing the engine a source string. Route the site through \
             `Coder::report_kind` with a KIND — `Syntax` for a spec early \
             error, `Unsupported` for a construct this compiler has not \
             ported — or fix the invariant.{detail}",
            files.len(),
            panics.len()
        );
    }
    eprintln!(
        "corpus_compiler_totality: {} test262 source(s) swept, {compiled} \
         returned, 0 panicked",
        files.len()
    );
}
