//! Exercise the actual CLI exit status when a committed list quarantines an
//! exact failure. A changed reason or lost coverage must still fail the gate.

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

use ironhorse_262::expectations::{Expectations, Outcome};

struct Fixture(PathBuf);

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl Fixture {
    fn run(&self, flags: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_endot-ih"))
            .arg("--test262-dir")
            .arg(&self.0)
            .args(["--case-timeout", "5"])
            .args(flags)
            .arg("language")
            .env("GARDEN_TEST262_TIP", "expectation-cli-fixture")
            .output()
            .expect("run endot-ih")
    }
}

#[test]
fn exact_expected_failures_are_green_but_changed_or_skipped_failures_are_red() {
    let fixture = Fixture(
        std::env::temp_dir().join(format!("ironhorse-expectation-cli-{}", std::process::id())),
    );
    fs::create_dir(&fixture.0).unwrap();
    fs::create_dir_all(fixture.0.join("test/language")).unwrap();
    fs::create_dir(fixture.0.join("harness")).unwrap();
    fs::write(fixture.0.join("harness/sta.js"), "").unwrap();
    let source = fixture.0.join("test/language/fixture.js");
    // The pinned oracle binds Compartment and Ironhorse deliberately does not.
    // A raw fixture turns that known difference into an assertion-style error
    // only on Ironhorse, producing a real gating failure without harness files.
    fs::write(&source, "/*---\nflags: [raw]\n---*/\nif (typeof Compartment === 'undefined') throw 'Test262Error: fixture failure';").unwrap();
    let baseline = fixture.0.join("expected.txt");
    let baseline = baseline.to_str().unwrap();
    let generated = fixture.run(&["--update-expectations", baseline]);
    assert_eq!(
        generated.status.code(),
        Some(1),
        "without expectations, the ordinary failure bar remains red: {}",
        String::from_utf8_lossy(&generated.stdout)
    );
    let text = fs::read_to_string(baseline).unwrap();
    let mut expected = Expectations::parse(&text).unwrap();
    assert!(
        matches!(expected.entries.values().next(), Some(Outcome::Fail(reason)) if reason.contains("fixture failure"))
    );

    let matched = fixture.run(&["--expectations", baseline]);
    assert!(
        matched.status.success(),
        "{}",
        String::from_utf8_lossy(&matched.stdout)
    );
    assert!(String::from_utf8_lossy(&matched.stdout).contains("1 expected failure(s)"));

    for outcome in expected.entries.values_mut() {
        *outcome = Outcome::Fail("a different previously known defect".into());
    }
    fs::write(baseline, expected.to_text()).unwrap();
    let changed = fixture.run(&["--expectations", baseline]);
    assert_eq!(changed.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&changed.stdout).contains("FAIL-MOVED"));

    fs::write(baseline, text).unwrap();
    fs::write(&source, "/*---\nflags: [raw]\n---*/\nthrow 1;").unwrap();
    let skipped = fixture.run(&["--expectations", baseline]);
    assert_eq!(skipped.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&skipped.stdout).contains("FAIL-SKIPPED"));
}
