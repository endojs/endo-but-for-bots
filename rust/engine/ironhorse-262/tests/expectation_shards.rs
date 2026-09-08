//! A whole-tree gate must bind its complete batch inventory and invalidate
//! resumed results whenever a committed shard changes.

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

use ironhorse_262::report::batch_filename;

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl Fixture {
    fn shell(&self, operation: &str) -> Output {
        Command::new("bash")
            .args(["-euo", "pipefail", "-c"])
            .arg("source \"$1\"; case \"$2\" in validate) validate_expectation_shards \"$3/shards\" \"$3/discovery.txt\" \"$4\";; digest) expectation_shards_digest \"$3/shards\";; esac")
            .arg("expectation-shard-test")
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/scripts/expectation-shards.sh"))
            .arg(operation)
            .arg(&self.0)
            .arg(env!("CARGO_BIN_EXE_ironhorse-262-report"))
            .output()
            .expect("run shared shard checks")
    }
}

#[test]
fn manifest_inventory_and_resume_identity_cannot_lose_cases() {
    let fixture =
        Fixture(std::env::temp_dir().join(format!("ih262-shards-{}", std::process::id())));
    fs::create_dir(&fixture.0).unwrap();
    let shards = fixture.0.join("shards");
    fs::create_dir(&shards).unwrap();
    let batches = ["language/call@@0000", "language/throw@@0000"];
    let manifest = format!("{}\n{}\n", batches[0], batches[1]);
    fs::write(fixture.0.join("discovery.txt"), &manifest).unwrap();
    fs::write(shards.join("manifest.txt"), &manifest).unwrap();
    let names: Vec<_> = batches
        .iter()
        .map(|batch| batch_filename(batch).replace(".json", ".txt"))
        .collect();
    for name in &names {
        fs::write(shards.join(name), "# fixture\ncase.js sloppy pass\n").unwrap();
    }
    assert!(fixture.shell("validate").status.success());
    let original_digest = fixture.shell("digest");
    assert!(original_digest.status.success());
    fs::write(
        shards.join(&names[0]),
        "# fixture\ncase.js sloppy fail:\"changed\"\n",
    )
    .unwrap();
    assert_ne!(original_digest.stdout, fixture.shell("digest").stdout);

    fs::remove_file(shards.join(&names[0])).unwrap();
    assert!(
        !fixture.shell("validate").status.success(),
        "missing shard must fail"
    );
    fs::write(shards.join(&names[0]), "restored").unwrap();
    fs::write(shards.join("unlisted.txt"), "extra").unwrap();
    assert!(
        !fixture.shell("validate").status.success(),
        "unexpected shard must fail"
    );
    fs::remove_file(shards.join("unlisted.txt")).unwrap();
    fs::write(fixture.0.join("discovery.txt"), format!("{}\n", batches[0])).unwrap();
    assert!(
        !fixture.shell("validate").status.success(),
        "deleted batch must fail before workers run"
    );
    fs::write(
        fixture.0.join("discovery.txt"),
        format!("{manifest}language/new@@0000\n"),
    )
    .unwrap();
    assert!(
        !fixture.shell("validate").status.success(),
        "new batch must fail before workers run"
    );
}

#[cfg(unix)]
#[test]
fn complete_reports_retain_failed_ratchets_across_resume_and_quarantine() {
    use std::os::unix::fs::PermissionsExt;

    fn run(command: &mut Command) {
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    fn executable(path: &std::path::Path, text: &str) {
        fs::write(path, text).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    fn commit(path: &std::path::Path) {
        run(Command::new("git").arg("-C").arg(path).args(["init", "-q"]));
        run(Command::new("git").arg("-C").arg(path).args(["add", "."]));
        run(Command::new("git").arg("-C").arg(path).args([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "fixture",
        ]));
    }

    let fixture =
        Fixture(std::env::temp_dir().join(format!("ih262-full-run-{}", std::process::id())));
    let root = &fixture.0;
    let scripts = root.join("rust/engine/ironhorse-262/scripts");
    let corpus = root.join("corpus");
    let target = root.join("target");
    let shards = root.join("shards");
    for directory in [
        &scripts,
        &corpus.join("harness"),
        &corpus.join("test/language"),
        &root.join("c/moddable"),
        &target.join("release"),
        &root.join("bin"),
        &shards,
    ] {
        fs::create_dir_all(directory).unwrap();
    }
    for name in ["full-run.sh", "expectation-shards.sh"] {
        fs::copy(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("scripts")
                .join(name),
            scripts.join(name),
        )
        .unwrap();
    }
    fs::copy(
        concat!(env!("CARGO_MANIFEST_DIR"), "/TEST262_REVISION"),
        scripts.parent().unwrap().join("TEST262_REVISION"),
    )
    .unwrap();
    fs::write(corpus.join("harness/sta.js"), "").unwrap();
    fs::write(
        corpus.join("test/language/probe.js"),
        "/*---\nflags: [raw]\n---*/\n42;\n",
    )
    .unwrap();
    commit(&corpus);
    fs::write(root.join("c/moddable/fixture"), "fixture").unwrap();
    commit(&root.join("c/moddable"));
    fs::write(
        root.join(".gitignore"),
        "bin/\ntarget/\noutput/\nquarantined/\nshards/\ncalls\nmode\ntimeouts\n",
    )
    .unwrap();
    commit(root);
    executable(&root.join("bin/cargo"), "#!/bin/sh\nexit 0\n");
    std::os::unix::fs::symlink(
        env!("CARGO_BIN_EXE_ironhorse-262-report"),
        target.join("release/ironhorse-262-report"),
    )
    .unwrap();
    // The executable stub preserves the real runner's complete, run-ID-bound
    // JSON, while independently forcing a gate failure. Quarantine mode emits
    // no JSON, so production retry and quarantine behavior is exercised too.
    executable(
        &target.join("release/endot-ih"),
        r#"#!/usr/bin/env bash
set -euo pipefail
printf 'called\n' >> "$FIXTURE_ROOT/calls"
previous=""
for argument in "$@"; do
  if [ "$previous" = --case-timeout ]; then printf '%s\n' "$argument" >> "$FIXTURE_ROOT/timeouts"; fi
  previous="$argument"
done
if [ -f "$FIXTURE_ROOT/mode" ]; then
  if [ "$(cat "$FIXTURE_ROOT/mode")" = real ]; then exec "$REAL_RUNNER" "$@"; fi
  exit 2
fi
arguments=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --strict-skip-reasons) shift ;;
    --expectations) shift 2 ;;
    *) arguments+=("$1"); shift ;;
  esac
done
"$REAL_RUNNER" "${arguments[@]}"
exit 1
"#,
    );
    let batch = "language@@0000";
    fs::write(shards.join("manifest.txt"), format!("{batch}\n")).unwrap();
    fs::write(
        shards.join(batch_filename(batch).replace(".json", ".txt")),
        "fixture baseline consumed by stub\n",
    )
    .unwrap();
    let invoke_mode =
        |output: &str, option: &str, baseline: &std::path::Path, timeout: Option<&str>| {
            Command::new("bash")
                .arg(scripts.join("full-run.sh"))
                .args(["--test262-dir"])
                .arg(&corpus)
                .args(["--output"])
                .arg(root.join(output))
                .arg(option)
                .arg(baseline)
                .args(["--jobs", "1", "--oracle", "off", "--no-fetch"])
                .args(
                    timeout
                        .map(|n| vec!["--case-timeout", n])
                        .unwrap_or_default(),
                )
                .env(
                    "PATH",
                    format!(
                        "{}:{}",
                        root.join("bin").display(),
                        std::env::var("PATH").unwrap()
                    ),
                )
                .env("CARGO_TARGET_DIR", &target)
                .env_remove("CARGO_BUILD_TARGET")
                .env("FIXTURE_ROOT", root)
                .env("REAL_RUNNER", env!("CARGO_BIN_EXE_endot-ih"))
                .output()
                .unwrap()
        };
    let invoke = |output: &str| invoke_mode(output, "--expectations-dir", &shards, None);
    let first = invoke("output");
    assert_eq!(
        first.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    assert!(
        root.join("output/results")
            .join(batch_filename(batch))
            .is_file(),
        "complete JSON is promoted despite failed gate"
    );
    assert!(root.join("output/report.json").is_file());
    assert_eq!(
        fs::read_to_string(root.join("calls"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    let resumed = invoke("output");
    assert_eq!(
        resumed.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&resumed.stderr)
    );
    assert_eq!(
        fs::read_to_string(root.join("calls"))
            .unwrap()
            .lines()
            .count(),
        1,
        "resume must retain the failed gate without rerunning a complete batch"
    );

    fs::write(root.join("mode"), "quarantine").unwrap();
    let quarantine = invoke("quarantined");
    assert_eq!(
        quarantine.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&quarantine.stderr)
    );
    assert_eq!(
        fs::read_to_string(root.join("calls"))
            .unwrap()
            .lines()
            .count(),
        4,
        "failed worker is retried three times"
    );
    assert!(root.join("quarantined/report.json").is_file());
    let resumed = invoke("quarantined");
    assert_eq!(resumed.status.code(), Some(1));
    assert_eq!(
        fs::read_to_string(root.join("calls"))
            .unwrap()
            .lines()
            .count(),
        4,
        "quarantined resume stays failed without new attempts"
    );

    // Run the actual runner through generation and comparison to exercise
    // shard argument forwarding, portable corpus headers, and atomic manifest
    // publication. An actual failing positive test makes generation exit 1;
    // that is a complete observation, and its exact Fail reason must compare
    // successfully afterward. Only the build command remains stubbed here.
    fs::write(
        corpus.join("test/language/probe.js"),
        "/*---\nflags: [raw]\n---*/\nif (typeof Compartment === 'undefined') throw 'Test262Error: baseline failure';\n",
    )
    .unwrap();
    commit(&corpus);
    fs::write(root.join("mode"), "real").unwrap();
    let generated = root.join("generated");
    let generation = invoke_mode(
        "generated-output",
        "--update-expectations-dir",
        &generated,
        None,
    );
    assert!(
        generation.status.success(),
        "{}",
        String::from_utf8_lossy(&generation.stderr)
    );
    assert!(generated.join("manifest.txt").is_file());
    let baseline =
        fs::read_to_string(generated.join(batch_filename(batch).replace(".json", ".txt"))).unwrap();
    assert!(baseline.contains("fail:\""), "{baseline}");
    let comparison = invoke_mode("compared-output", "--expectations-dir", &generated, None);
    assert!(
        comparison.status.success(),
        "{}",
        String::from_utf8_lossy(&comparison.stderr)
    );
    // Default and explicit identical bounds reuse results. A changed bound
    // reruns the batch, including when every other input is unchanged.
    let calls = || {
        fs::read_to_string(root.join("calls"))
            .unwrap()
            .lines()
            .count()
    };
    let before = calls();
    assert!(
        invoke_mode("timeout-output", "--expectations-dir", &generated, None)
            .status
            .success()
    );
    assert_eq!(calls(), before + 1);
    let provenance = || fs::read_to_string(root.join("timeout-output/provenance.json")).unwrap();
    let field = |text: &str, key: &str| {
        let prefix = format!("\"{key}\":");
        text.lines()
            .find(|line| line.trim_start().starts_with(&prefix))
            .unwrap()
            .to_string()
    };
    let default_provenance = provenance();
    for key in ["run_id", "config"] {
        assert!(field(&default_provenance, key).contains("case-timeout=60"));
    }
    assert!(field(&default_provenance, "command").contains("--case-timeout 60"));
    assert!(invoke_mode(
        "timeout-output",
        "--expectations-dir",
        &generated,
        Some("60")
    )
    .status
    .success());
    assert_eq!(calls(), before + 1, "same bound must resume");
    assert!(invoke_mode(
        "timeout-output",
        "--expectations-dir",
        &generated,
        Some("61")
    )
    .status
    .success());
    assert_eq!(
        calls(),
        before + 2,
        "changed timeout must invalidate cached results"
    );
    let changed = provenance();
    assert_ne!(
        field(&changed, "run_id"),
        field(&default_provenance, "run_id")
    );
    assert!(field(&changed, "config").contains("case-timeout=61"));
    let forwarded = fs::read_to_string(root.join("timeouts")).unwrap();
    assert!(forwarded.lines().rev().take(2).eq(["61", "60"]));
    for invalid in ["0", "-1", "no", "3601", "99999999999999999999"] {
        let outcome = invoke_mode(
            "invalid-timeout",
            "--expectations-dir",
            &generated,
            Some(invalid),
        );
        assert_eq!(outcome.status.code(), Some(2), "{invalid}");
        assert!(String::from_utf8_lossy(&outcome.stderr)
            .contains("--case-timeout needs seconds (1..3600)"));
    }
    assert_eq!(calls(), before + 2, "invalid bounds must not start workers");
}
