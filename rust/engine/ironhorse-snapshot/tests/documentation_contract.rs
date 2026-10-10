//! Keep the persistence rationale aligned with the executable coverage ledger.
use std::collections::BTreeMap;

use ironhorse_snapshot::sidetable::{Coverage, SideTable};

fn variant_docs(source: &str) -> BTreeMap<String, String> {
    let body = source
        .split_once("pub enum SideTable {")
        .expect("SideTable declaration")
        .1
        .split_once('}')
        .expect("SideTable closing brace")
        .0;
    // Pin the actual documentation emitter, then inspect the same metadata
    // it expands. A stale handwritten doc or a disconnected binding fails here.
    assert_eq!(
        body.split_whitespace().collect::<String>(),
        "$(#[doc=$display]$variant=$id,)*",
        "SideTable documentation must come from the roster"
    );
    macro_rules! collect_docs {
        ($($variant:ident, $id:literal, $order:literal, $coverage:ident,
            $primary:expr, $display:literal;)*) => {{
            let rows = [$( (stringify!($variant).to_string(), $display.to_string()), )*];
            let count = rows.len();
            let docs: BTreeMap<_, _> = rows.into_iter().collect();
            assert_eq!(docs.len(), count, "duplicate documentation entry");
            docs
        }};
    }
    ironhorse_vm::interp_tables!(collect_docs)
}

#[test]
fn generated_variant_docs_require_the_roster_binding() {
    let source = include_str!("../src/sidetable.rs");
    for replacement in ["", "#[doc = \"uncallable\"]"] {
        let changed = source.replace("#[doc = $display]", replacement);
        assert_ne!(changed, source);
        assert!(std::panic::catch_unwind(|| variant_docs(&changed)).is_err());
    }
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
        assert_eq!(
            doc,
            table.descriptor().field,
            "{name} documentation binding"
        );
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
