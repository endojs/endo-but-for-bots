//! Rust-side runner over the glob variant coverage matrix.
//!
//! This is the Rust half of the cross-language parity contract described in
//! `designs/mount-extensions-reconstruction.md` § "Test strategy". It consumes
//! the same `packages/daemon/test/mount-glob-cases.json` the Node runner
//! (`mount-glob.test.js`) iterates, materializes the same
//! `mount-fixture-manifest.json`, and asserts a Rust mirror of `mount.js`'s
//! glob semantics reproduces each pinned `expect` byte-for-byte.
//!
//! A discrepancy is one of: a Node-side glob regression (the case table's
//! `expect` no longer matches `mount.js`), or a drift between the normative
//! glob spec and this Rust mirror. Either way it wants a human.

use std::collections::HashSet;

use mount_parity::{contract_dir, default_denied_segments, glob, materialize_fixture};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct GlobCase {
    name: String,
    pattern: String,
    expect: Vec<String>,
    #[serde(default, rename = "requiresSymlink")]
    requires_symlink: bool,
}

#[derive(Debug, Deserialize)]
struct GlobCases {
    cases: Vec<GlobCase>,
}

fn load_glob_cases() -> Vec<GlobCase> {
    let path = contract_dir().join("mount-glob-cases.json");
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let parsed: GlobCases =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
    parsed.cases
}

#[test]
fn glob_variant_case_table_matches_the_shared_fixture() {
    let parent = tempfile::tempdir().expect("temp dir");
    let fixture = materialize_fixture(parent.path()).expect("materialize fixture");
    let have_symlink = fixture.created.contains("escape");
    let denied = default_denied_segments();

    let cases = load_glob_cases();
    let mut ran = 0usize;
    for case in &cases {
        if case.requires_symlink && !have_symlink {
            // The platform could not create the escaping symlink; its
            // confinement expectation is unobservable here (mirrors the Node
            // runner's gate).
            continue;
        }
        let actual = glob(&fixture.root, &case.pattern, &denied)
            .unwrap_or_else(|e| panic!("{} — glob({:?}) errored: {e}", case.name, case.pattern));
        assert_eq!(
            actual, case.expect,
            "{} — glob({:?})",
            case.name, case.pattern
        );
        ran += 1;
    }
    // Guard against a silently-empty table or a broken loop reporting green,
    // mirroring the Node runner's `ran >= 30` floor.
    assert!(
        ran >= 30,
        "expected the matrix to exercise many cases, ran {ran}"
    );
}

#[test]
fn glob_rejects_a_pattern_with_no_non_empty_segments() {
    let parent = tempfile::tempdir().expect("temp dir");
    let fixture = materialize_fixture(parent.path()).expect("materialize fixture");
    let denied = default_denied_segments();
    for pattern in ["", "/", "///"] {
        let result = glob(&fixture.root, pattern, &denied);
        assert!(
            result.is_err(),
            "glob({pattern:?}) must reject a pattern with no non-empty segment"
        );
        let message = result.unwrap_err();
        assert!(
            message.contains("at least one non-empty segment"),
            "glob({pattern:?}) error was {message:?}"
        );
    }
}

#[test]
fn empty_deny_set_admits_the_credential_names() {
    // An empty denied set disables denial entirely, so the well-known
    // credential names become visible to glob. This proves the case table's
    // empty results for `.ssh` / `.env` are load-bearing on the deny filter,
    // not on the names being absent from the fixture — the Rust mirror of
    // mount-glob.test.js's "overridden empty deny set" test.
    let parent = tempfile::tempdir().expect("temp dir");
    let fixture = materialize_fixture(parent.path()).expect("materialize fixture");
    let empty: HashSet<String> = HashSet::new();

    assert_eq!(
        glob(&fixture.root, ".ssh/*", &empty).unwrap(),
        vec![".ssh/id_rsa".to_string()],
    );
    assert_eq!(
        glob(&fixture.root, ".env", &empty).unwrap(),
        vec![".env".to_string()],
    );

    // ...and with the default deny set they are excluded, as the case table pins.
    let denied = default_denied_segments();
    assert!(glob(&fixture.root, ".ssh/*", &denied).unwrap().is_empty());
    assert!(glob(&fixture.root, ".env", &denied).unwrap().is_empty());
}

#[test]
fn glob_caps_results_at_glob_max_with_deterministic_truncation() {
    // A wide tree just over the cap. Zero-padded names so UTF-16 order is the
    // obvious numeric order and the truncation boundary is predictable —
    // the Rust mirror of mount-glob.test.js's truncation test.
    let parent = tempfile::tempdir().expect("temp dir");
    let root = parent.path().join("wide");
    std::fs::create_dir(&root).unwrap();
    let total = mount_parity::GLOB_MAX_RESULTS + 5;
    for i in 0..total {
        std::fs::write(root.join(format!("f{i:06}.txt")), b"").unwrap();
    }
    let denied = default_denied_segments();
    let result = glob(&root, "*", &denied).unwrap();
    assert_eq!(result.len(), mount_parity::GLOB_MAX_RESULTS);
    assert_eq!(result[0], "f000000.txt");
    assert_eq!(
        result[mount_parity::GLOB_MAX_RESULTS - 1],
        format!("f{:06}.txt", mount_parity::GLOB_MAX_RESULTS - 1)
    );
    // The entries past the cap are dropped, not surfaced.
    assert!(!result.contains(&format!("f{:06}.txt", total - 1)));
}
