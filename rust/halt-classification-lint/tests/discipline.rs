//! The classification-discipline lint's own verification
//! (designs/ironhorse-panic.md § Verification, the classification-discipline
//! bullet): the raw commit-path fixture fails, its predicate-routed twin
//! passes, the checkout itself is clean, and each pattern form the rule
//! covers is caught.

use std::path::Path;

use halt_classification_lint::{lint_source, lint_tree, scope_files, Allow, Finding, ALLOWED};

fn repo() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
}

fn lint(source: &str) -> Vec<Finding> {
    lint_source("rust/endo/src/example.rs", source, ALLOWED)
        .expect("fixture parses")
        .findings
}

fn fixture(name: &str) -> Vec<Finding> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(name);
    let source = std::fs::read_to_string(&path).expect("fixture readable");
    lint_source(&format!("fixtures/{name}"), &source, ALLOWED)
        .expect("fixture parses")
        .findings
}

#[test]
fn raw_commit_path_match_fails() {
    let findings = fixture("commit_path_raw_match.rs");
    let named: Vec<_> = findings.iter().map(|f| f.message.as_str()).collect();
    assert_eq!(findings.len(), 2, "{named:#?}");
    assert!(named[0].contains("`Halt::StackOverflow`"), "{named:#?}");
    assert!(named[1].contains("`Halt::Decode`"), "{named:#?}");
    assert!(findings
        .iter()
        .all(|f| f.item == "settle_crank" && f.line == 16));
}

#[test]
fn predicate_routed_twin_passes() {
    assert_eq!(fixture("commit_path_routed.rs"), vec![]);
}

#[test]
fn checkout_is_clean() {
    let files = scope_files(repo()).expect("scope walk");
    assert!(
        files.contains(&"rust/endo/src/ironhorse_engine.rs".to_string()),
        "the Machine seam must be in scope: {files:#?}"
    );
    assert!(files.iter().all(|f| !f.starts_with("rust/engine/")));
    let findings = lint_tree(repo(), ALLOWED).expect("tree lints");
    let rendered: Vec<String> = findings.iter().map(ToString::to_string).collect();
    assert!(findings.is_empty(), "{rendered:#?}");
}

#[test]
fn every_pattern_form_is_caught() {
    let findings = lint(
        r#"
        use ironhorse_vm::Halt;
        fn decide(halt: &Halt, other: Halt) -> bool {
            if let Halt::MeterAbort = halt { return true; }
            let Halt::Panic(kind) = other else { return false; };
            let a = matches!(halt, Halt::ReentryLimit { .. });
            let b = halt == &Halt::StackOverflow(0);
            assert!(matches!(other, Halt::StepLimit(_)));
            assert_eq!(*halt, Halt::HeapExhausted);
            while let Halt::EngineInvariant(_) = halt {}
            a || b
        }
        "#,
    );
    let variants: Vec<_> = findings
        .iter()
        .map(|f| f.message.split('`').nth(1).unwrap_or_default().to_string())
        .collect();
    assert_eq!(
        variants,
        [
            "Halt::MeterAbort",
            "Halt::Panic",
            "Halt::ReentryLimit",
            "Halt::StackOverflow",
            "Halt::StepLimit",
            "Halt::HeapExhausted",
            "Halt::EngineInvariant",
        ]
    );
}

#[test]
fn qualified_paths_aliases_and_variant_imports_are_caught() {
    let findings = lint(
        r#"
        use crate::ironhorse_engine::engine::Halt as EngineHalt;
        use ironhorse_vm::Halt::*;
        type H = ironhorse_vm::Halt;
        impl Supervisor {
            fn settle(&self, halt: EngineHalt) {
                match halt {
                    ironhorse_vm::Halt::Decode(_) => {}
                    EngineHalt::MeterAbort => {}
                    H::StackOverflow(n) => {}
                    _ => {}
                }
            }
        }
        "#,
    );
    let rendered: Vec<String> = findings.iter().map(ToString::to_string).collect();
    assert_eq!(findings.len(), 4, "{rendered:#?}");
    assert!(findings[0].message.contains("imports `Halt` variants"));
    assert_eq!(findings[1].item, "Supervisor::settle");
    assert!(findings[1].message.contains("`Halt::Decode`"));
    assert!(findings[2].message.contains("`EngineHalt::MeterAbort`"));
    assert!(findings[3].message.contains("`H::StackOverflow`"));
}

#[test]
fn test_code_and_construction_are_out_of_scope() {
    let findings = lint(
        r#"
        fn produce() -> Halt { Halt::StackOverflow(3) }
        fn wrap(halt: Halt) -> MachineError { MachineError::Halt(halt) }
        #[cfg(test)]
        mod tests {
            fn t(h: Halt) { assert!(matches!(h, Halt::MeterAbort)); }
        }
        #[cfg(all(feature = "x", test))]
        fn also_test(h: Halt) -> bool { matches!(h, Halt::MeterAbort) }
        #[test]
        fn a_test() { assert!(matches!(produce(), Halt::StackOverflow(_))); }
        "#,
    );
    assert_eq!(findings, vec![]);
}

#[test]
fn cfg_not_test_is_production_code() {
    let findings = lint(
        r#"
        #[cfg(not(test))]
        fn live(h: Halt) -> bool { matches!(h, Halt::MeterAbort) }
        "#,
    );
    assert_eq!(findings.len(), 1);
}

#[test]
fn allowlist_is_per_file_and_per_function() {
    const ALLOW: &[Allow] = &[Allow {
        file: "rust/endo/src/example.rs",
        item: "Outcome::classify",
        reason: "test",
    }];
    let source = r#"
        impl Outcome { fn classify(h: Halt) -> bool { matches!(h, Halt::MeterAbort) } }
        impl Other { fn classify(h: Halt) -> bool { matches!(h, Halt::MeterAbort) } }
    "#;
    let here = lint_source("rust/endo/src/example.rs", source, ALLOW).unwrap();
    assert_eq!(here.findings.len(), 1);
    assert_eq!(here.findings[0].item, "Other::classify");
    assert!(here.allows_used.contains(&0));
    let elsewhere = lint_source("rust/endo/src/other.rs", source, ALLOW).unwrap();
    assert_eq!(elsewhere.findings.len(), 2);
}

#[test]
fn stale_allowlist_entry_is_a_finding() {
    const STALE: &[Allow] = &[Allow {
        file: "rust/endo/src/ironhorse_engine.rs",
        item: "no_such_function",
        reason: "test",
    }];
    let findings = lint_tree(repo(), STALE).expect("tree lints");
    assert!(
        findings
            .iter()
            .any(|f| f.item == "no_such_function" && f.message.contains("stale")),
        "{findings:#?}"
    );
}
