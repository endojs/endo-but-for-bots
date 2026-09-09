//! Keep the persistence rationale aligned with the executable coverage ledger.
use std::collections::BTreeMap;

use ironhorse_snapshot::sidetable::{Coverage, SideTable};

fn variant_docs(source: &str) -> BTreeMap<String, String> {
    let body = source
        .split_once("pub enum SideTable {")
        .expect("SideTable declaration")
        .1
        .split_once("\n}")
        .expect("SideTable closing brace")
        .0;
    let mut docs = BTreeMap::new();
    let mut pending = String::new();
    for line in body.lines().map(str::trim) {
        if let Some(doc) = line.strip_prefix("///") {
            pending.push_str(doc);
            pending.push('\n');
        } else if let Some(name) = line.strip_suffix(',') {
            assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
            assert!(docs
                .insert(name.to_string(), std::mem::take(&mut pending))
                .is_none());
        } else {
            assert!(line.is_empty(), "unrecognized variant syntax: {line}");
        }
    }
    docs
}

fn assert_carried_doc(name: &str, doc: &str) {
    assert!(
        !doc.contains("Pending"),
        "serialized {name} has stale rationale: {doc}"
    );
    let lower = doc.to_ascii_lowercase();
    for stale in [
        "uncallable",
        "cannot yet round-trip",
        "deliberately dropped",
        "do not yet travel",
        "does not yet travel",
        "carry is a recorded follow-up",
    ] {
        assert!(
            !lower.contains(stale),
            "serialized {name} has stale rationale: {doc}"
        );
    }
}

#[test]
fn serialized_variants_do_not_claim_pending_or_uncallable() {
    let docs = variant_docs(include_str!("../src/sidetable.rs"));
    assert_eq!(docs.len(), SideTable::ALL.len());
    for table in SideTable::ALL {
        let name = format!("{table:?}");
        let doc = docs.get(&name).expect("each variant has a doc block");
        assert!(!doc.trim().is_empty(), "{name} needs documentation");
        if table.descriptor().coverage == Coverage::Serialized {
            assert_carried_doc(&name, doc);
        }
    }
}

#[test]
#[should_panic(expected = "serialized Proxies has stale rationale")]
fn rejects_old_dependency_gate_rationale() {
    assert_carried_doc(
        "Proxies",
        "Pending until functions carry: resumed traps are uncallable",
    );
}

#[test]
fn pending_guest_work_is_not_pending_coverage() {
    assert_carried_doc(
        "Promises",
        "Serialized pending promises retain their reactions.",
    );
}
