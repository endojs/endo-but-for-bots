//! Run existing test sources and harnesses after native lockdown, without a
//! SES shim or a second copy of their assertions. The hardened262 status
//! baseline remains owned by that package, including its known failures.

use ironhorse_262::expectations::{Mode, Outcome};
use ironhorse_262::frontmatter;
use ironhorse_262::xst::{run_case, strict_mode_status, Config, SesMode, Verdict};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn source_files(directory: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(directory).expect("existing corpus directory") {
        let path = entry.expect("read corpus entry").path();
        if path.is_dir() {
            files.extend(source_files(&path));
        } else if path.extension().is_some_and(|extension| extension == "js") {
            files.push(path);
        }
    }
    files.sort();
    files
}

fn config() -> Config {
    Config {
        ses_mode: SesMode::Lockdown,
        // Native lockdown is the setup. Loading SES here would test a
        // different implementation of the operation this gate protects.
        prelude: None,
        ..Config::default()
    }
}

fn on_engine_stack(run: impl FnOnce() + Send + 'static) {
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(run)
        .unwrap()
        .join()
        .unwrap();
}

/// Match the package's generic only*/no* qualifiers for the native locked
/// script scenarios. Unknown positive qualifiers exclude; unknown negative
/// qualifiers do not. Strict selection itself is delegated to xst.
fn qualifies(flags: &[String], mode: Mode) -> bool {
    let enabled = |qualifier: &str| match qualifier {
        "Ironhorse" | "Lockdown" => true,
        "Sloppy" => mode == Mode::Sloppy,
        "Strict" => mode == Mode::Strict,
        _ => false,
    };
    flags.iter().all(|flag| {
        if let Some(qualifier) = flag.strip_prefix("only") {
            enabled(qualifier)
        } else if let Some(qualifier) = flag.strip_prefix("no") {
            !enabled(qualifier)
        } else {
            true
        }
    })
}

#[test]
fn hardened262_native_lockdown_matches_existing_baselines() {
    on_engine_stack(|| {
        let package = repository().join("packages/hardened262");
        let mut expected = BTreeMap::new();
        for (mode, scenario) in [
            (Mode::Sloppy, "lockdownSloppy"),
            (Mode::Strict, "lockdownStrict"),
        ] {
            for (status, pass) in [("passed", true), ("failed", false)] {
                let list = package.join(format!("baseline/ironhorse/{scenario}/{status}.txt"));
                for file in std::fs::read_to_string(&list).unwrap().lines() {
                    assert!(package.join(file).is_file(), "stale baseline: {file}");
                    assert!(
                        expected.insert((file.to_string(), mode), pass).is_none(),
                        "duplicate baseline: {scenario} {file}"
                    );
                }
            }
            assert!(
                std::fs::read_to_string(
                    package.join(format!("baseline/ironhorse/{scenario}/skipped.txt"))
                )
                .unwrap()
                .trim()
                .is_empty(),
                "native baseline must not hide skips"
            );
        }

        let cfg = config();
        let mut inventoried = BTreeSet::new();
        let mut drift = Vec::new();
        let mut passed = 0;
        let mut failed = 0;
        let mut excluded = 0;
        for path in source_files(&package.join("test")) {
            let file = path.strip_prefix(&package).unwrap().to_str().unwrap();
            let source = std::fs::read_to_string(&path).unwrap();
            let metadata = frontmatter::parse(&source);
            assert!(metadata.present, "missing frontmatter: {file}");
            if metadata.flags.iter().any(|flag| flag == "module") {
                eprintln!("excluded (scenario flags): {file}");
                excluded += 1;
                continue;
            }
            let (sloppy, strict, _) = strict_mode_status(&metadata.flags);
            let modes: Vec<_> = [(Mode::Sloppy, sloppy), (Mode::Strict, strict)]
                .into_iter()
                .filter_map(|(mode, selected)| {
                    (selected && qualifies(&metadata.flags, mode)).then_some(mode)
                })
                .collect();
            if modes.is_empty() {
                eprintln!("excluded (scenario flags): {file}");
                excluded += 1;
                continue;
            }
            for mode in &modes {
                inventoried.insert((file.to_string(), *mode));
            }
            if file.starts_with("test/Compartment/") || file.starts_with("test/modules/") {
                eprintln!("excluded (guest Compartment/module API): {file}");
                for mode in modes {
                    assert_eq!(expected.get(&(file.to_string(), mode)), Some(&false));
                }
                excluded += 1;
                continue;
            }

            let result = run_case(&cfg, &package.join("harness"), &source);
            for mode in modes {
                let outcome = result
                    .mode_outcomes
                    .iter()
                    .find(|(found, _)| *found == mode);
                // Require evidence that the selected body actually ran.
                // The legacy runner calls identical positive-test aborts a
                // "skip" even though both engines executed the assertions;
                // that one classification is a failure in hardened262's
                // existing baseline. Structural/infrastructure skips and
                // setup failures must never satisfy a known body failure.
                //
                // `shared-test262-failure` is the same category and is
                // accepted for the same reason: `xst.rs` reaches it only when
                // BOTH engines threw the harness's own `Test262Error` with an
                // agreeing message, which means ironhorse ran far enough to
                // assert and lost. It appears here now because the subject run
                // renders an escaping throw with the guest's `toString`, as
                // the oracle shim does; before that, a shared failure could
                // not be told from a disagreement, since every ironhorse
                // `Test262Error` rendered as `Object: …` and never agreed.
                let pass = match outcome {
                    Some((_, Outcome::Pass)) => true,
                    Some((_, Outcome::Fail(reason)))
                        if !reason.is_empty() && !reason.starts_with("setup ") =>
                    {
                        false
                    }
                    Some((_, Outcome::Skip(reason)))
                        if reason == "shared-positive-test-failure"
                            || reason == "shared-test262-failure" =>
                    {
                        false
                    }
                    _ => {
                        drift.push(format!(
                            "{file} {mode:?}: missing body execution: {outcome:?} {:?}",
                            result.verdict
                        ));
                        continue;
                    }
                };
                if pass {
                    passed += 1;
                } else {
                    failed += 1;
                    eprintln!(
                        "known failure {file} {mode:?}: {outcome:?} {:?}",
                        result.verdict
                    );
                }
                if expected.get(&(file.to_string(), mode)) != Some(&pass) {
                    drift.push(format!(
                        "{file} {mode:?}: expected {:?}, observed {outcome:?} {:?}",
                        expected.get(&(file.to_string(), mode)),
                        result.verdict
                    ));
                }
            }
        }
        let baseline_keys: BTreeSet<_> = expected.into_keys().collect();
        assert_eq!(inventoried, baseline_keys, "scenario inventory changed");
        eprintln!("native hardened262: {passed} passed, {failed} known failed script scenarios; {excluded} excluded files");
        assert!(passed > 0, "native lockdown coverage must not be empty");
        assert!(
            drift.is_empty(),
            "native lockdown baseline drift:\n{}",
            drift.join("\n")
        );
    });
}

#[test]
fn existing_stage4_harden_corpus_runs_after_native_lockdown() {
    on_engine_stack(|| {
        let corpus = repository().join("packages/test262-runner/test262");
        let cfg = config();
        let files = source_files(&corpus.join("test/ironhorse/built-ins/stage4-harden"));
        assert!(!files.is_empty(), "stage4-harden corpus must not disappear");
        let mut failures = Vec::new();
        for file in &files {
            let source = std::fs::read_to_string(file).unwrap();
            let result = run_case(&cfg, &corpus.join("harness"), &source);
            if !matches!(result.verdict, Verdict::Covered) || result.strict_skipped {
                failures.push(format!("{}: {result:?}", file.display()));
            }
        }
        eprintln!(
            "native lockdown stage4-harden: {} existing files",
            files.len()
        );
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    });
}
