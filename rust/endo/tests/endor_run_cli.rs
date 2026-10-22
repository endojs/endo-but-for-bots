//! `endor run` flag handling, driven through the built binary: the
//! `--zip` / `--dir` form overrides and the `--cas-dir` store location
//! from `designs/endor-run-expanded.md` § CLI changes.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const COMPARTMENT_MAP: &str = r#"{"entry":{"compartment":"entry-v1.0.0","module":"./main.js"},"compartments":{"entry-v1.0.0":{"name":"entry","modules":{"./main.js":{"parser":"mjs","location":"main.js"}}}}}"#;
const MAIN_SOURCE: &str = "console.log('hello from endor run');\n";
const GREETING: &str = "hello from endor run";

fn endor(arguments: &[&str], temporary_directory: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_endor"))
        .arg("run")
        .args(arguments)
        // Keep the default standalone CAS (`$TMPDIR/endor-cas`) away
        // from the shared temporary directory.
        .env("TMPDIR", temporary_directory)
        .output()
        .expect("spawn endor")
}

fn combined_output(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn archive_root(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    stderr
        .lines()
        .find_map(|line| line.strip_prefix("endor[run]: archive root "))
        .unwrap_or_else(|| panic!("no archive root in: {stderr}"))
        .trim()
        .to_string()
}

fn zip_bytes() -> Vec<u8> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut cursor);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("compartment-map.json", options).unwrap();
        zip.write_all(COMPARTMENT_MAP.as_bytes()).unwrap();
        zip.start_file("entry-v1.0.0/main.js", options).unwrap();
        zip.write_all(MAIN_SOURCE.as_bytes()).unwrap();
        zip.finish().unwrap();
    }
    cursor.into_inner()
}

fn write_archive_directory(root: &Path) -> PathBuf {
    let directory = root.join("app");
    std::fs::create_dir_all(directory.join("entry-v1.0.0")).unwrap();
    std::fs::write(directory.join("compartment-map.json"), COMPARTMENT_MAP).unwrap();
    std::fs::write(directory.join("entry-v1.0.0/main.js"), MAIN_SOURCE).unwrap();
    directory
}

#[test]
fn zip_flag_runs_an_archive_behind_a_stub() {
    let temporary = tempfile::tempdir().unwrap();
    let mut bytes = b"#!/bin/sh\nexec endor run --zip \"$0\"\n".to_vec();
    bytes.extend(zip_bytes());
    let bundle = temporary.path().join("bundle.sh");
    std::fs::write(&bundle, bytes).unwrap();
    let bundle = bundle.to_str().unwrap();

    let detected = endor(&[bundle], temporary.path());
    assert_eq!(
        detected.status.code(),
        Some(1),
        "{}",
        combined_output(&detected)
    );
    assert!(
        combined_output(&detected).contains("cannot tell the input form"),
        "{}",
        combined_output(&detected)
    );

    let forced = endor(&["--zip", bundle], temporary.path());
    assert!(forced.status.success(), "{}", combined_output(&forced));
    assert!(combined_output(&forced).contains(GREETING));
}

#[test]
fn cas_dir_holds_the_ingested_archive_for_replay() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = write_archive_directory(temporary.path());
    let cas_directory = temporary.path().join("store");
    let cas_directory_argument = cas_directory.to_str().unwrap();

    let ingest = endor(
        &[
            "--cas-dir",
            cas_directory_argument,
            "--dir",
            directory.to_str().unwrap(),
        ],
        temporary.path(),
    );
    assert!(ingest.status.success(), "{}", combined_output(&ingest));
    assert!(combined_output(&ingest).contains(GREETING));
    let root = archive_root(&ingest);
    assert!(cas_directory.is_dir());
    assert!(
        !temporary.path().join("endor-cas").exists(),
        "--cas-dir must replace the default store, not add to it"
    );

    let replay = endor(
        &["--cas-dir", cas_directory_argument, "--cas", &root],
        temporary.path(),
    );
    assert!(replay.status.success(), "{}", combined_output(&replay));
    assert!(combined_output(&replay).contains(GREETING));

    // The default store never saw the archive, so the same hash
    // does not resolve without the flag.
    let elsewhere = endor(&["--cas", &root], temporary.path());
    assert!(
        !elsewhere.status.success(),
        "{}",
        combined_output(&elsewhere)
    );
}

#[test]
fn contradictory_flags_are_usage_errors() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = write_archive_directory(temporary.path());
    let directory = directory.to_str().unwrap();
    let archive = temporary.path().join("app.zip");
    std::fs::write(&archive, zip_bytes()).unwrap();
    let archive = archive.to_str().unwrap();
    let entry = temporary.path().join("main.js");
    std::fs::write(&entry, MAIN_SOURCE).unwrap();
    let entry = entry.to_str().unwrap();

    for (arguments, expected) in [
        (
            vec!["--zip", "--dir", directory],
            "name different input forms",
        ),
        (vec!["--zip", directory], "--zip expects a regular file"),
        (vec!["--dir", archive], "--dir expects a directory"),
        (vec!["--dir", "--cas", "0000"], "do not apply to --cas"),
        (
            vec!["--no-cas", "--cas-dir", "store", archive],
            "contradict",
        ),
        (
            vec!["--cas-dir", "store", entry],
            "does not apply to the registry",
        ),
    ] {
        let output = endor(&arguments, temporary.path());
        assert_eq!(
            output.status.code(),
            Some(2),
            "{arguments:?}: {}",
            combined_output(&output)
        );
        assert!(
            combined_output(&output).contains(expected),
            "{arguments:?}: {}",
            combined_output(&output)
        );
    }
}
