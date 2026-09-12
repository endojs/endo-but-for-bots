//! Public row declarations and both persisted encodings advance together.
use ironhorse_snapshot::{format::IRONHORSE_FORMAT_VERSION, store::STORE_SCHEMA_VERSION};
use ironhorse_vm::{snapshot_api::ROW_SCHEMA_VERSION, source_scan::code_only};

// Keep only declarations, excluding comments, derives, whitespace and impls.
// Fail closed on a new declaration form instead of silently omitting it.
fn declarations(source: &str) -> String {
    let source = code_only(source);
    let mut declarations = Vec::new();
    let mut rest = source.as_str();
    while let Some(start) = rest.find("pub ") {
        rest = &rest[start..];
        let end = if rest.starts_with("pub struct ") {
            rest.find('}').expect("row struct closes") + 1
        } else if rest.starts_with("pub type ") {
            rest.find(';').expect("row alias closes") + 1
        } else {
            // Public methods live inside impls, which are not data contracts.
            assert!(
                rest.starts_with("pub fn "),
                "unclassified row declaration: {rest}"
            );
            rest = &rest[4..];
            continue;
        };
        declarations.push(rest[..end].split_whitespace().collect::<String>());
        rest = &rest[end..];
    }
    // Reordering unrelated declarations is not a schema change; field order is.
    declarations.sort();
    declarations.join("\n")
}

#[test]
fn row_schema_is_pinned_to_container_and_store_releases() {
    let mut schema = declarations(include_str!(
        "../../ironhorse-vm/src/interp/snapshot_rows.rs"
    ));
    schema.push('\n');
    schema.push_str(&declarations(include_str!(
        "../../ironhorse-vm/src/interp/intl_data.rs"
    )));
    let fingerprint = ironhorse_snapshot::sha256::hex_sha256(schema.as_bytes());
    let ledger = include_str!("fixtures/row_schema_releases.tsv");
    let mut previous = (0, 0, 0);
    let mut last_digest = "";
    for row in ledger
        .lines()
        .filter(|line| !line.starts_with('#') && !line.is_empty())
    {
        let fields: Vec<_> = row.split('\t').collect();
        assert_eq!(fields.len(), 4);
        let versions = (
            fields[0].parse::<u32>().unwrap(),
            fields[1].parse::<u32>().unwrap(),
            fields[2].parse::<u32>().unwrap(),
        );
        assert!(
            versions.0 > previous.0 && versions.1 > previous.1 && versions.2 > previous.2,
            "append a new row release and advance both encodings; never replace history"
        );
        previous = versions;
        last_digest = fields[3];
    }
    assert_eq!(previous.0, ROW_SCHEMA_VERSION);
    assert!(IRONHORSE_FORMAT_VERSION >= previous.1 && STORE_SCHEMA_VERSION >= previous.2);
    assert_eq!(fingerprint, last_digest,
        "row declarations changed: bump ROW_SCHEMA_VERSION and both encodings, append a release, and verify migrations/refusals and carried-state goldens");
}

#[test]
fn fingerprint_tracks_fields_and_aliases_but_ignores_docs_and_impls() {
    let baseline = "pub struct Row { pub owner: u32, pub value: Slot }";
    assert_eq!(
        declarations(baseline),
        declarations(&format!(
            "/// Documentation\n{baseline}\nimpl Row {{ pub fn len(&self) -> usize {{ 0 }} }}"
        ))
    );
    for changed in [
        "pub struct Row { pub owner: u64, pub value: Slot }",
        "pub struct Row { pub value: Slot, pub owner: u32 }",
        "pub struct Row { pub owner: u32, pub value: Slot, pub extra: bool }",
        "pub type Row = (u32, Slot);",
    ] {
        assert_ne!(declarations(baseline), declarations(changed));
    }
}
