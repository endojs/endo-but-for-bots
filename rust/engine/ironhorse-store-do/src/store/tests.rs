//! What this crate can check without a SQL engine: answers that contradict
//! the schema are errors with a deliberate class, never panics, and a
//! refusal the store raises itself comes before its first write. The suite
//! against real SQLite is `rust/endo/ironhorse-store-do-rusqlite`.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use ironhorse_snapshot::store::{image_to_batch, CommitToken, HeapStoreCommit, StoreFailure};
use ironhorse_snapshot::store_sections::merge_framed;
use ironhorse_snapshot::{MachineSnapshot, Signature};

use super::*;

/// Answers the table lookup with all six tables, the stamp and the manifest
/// lookups well (no manifest row when `manifest` is `None`), and every other
/// `SELECT` with `canned`. Writes answer nothing and are counted.
#[derive(Clone, Debug)]
struct Scripted {
    manifest: Option<Vec<u8>>,
    canned: Rc<RefCell<Vec<Vec<Value>>>>,
    writes: Rc<Cell<u32>>,
}

/// The answer to `existing_tables`' lookup when the schema exists.
fn all_tables() -> Vec<Vec<Value>> {
    TABLES.iter().map(|table| vec![text(table)]).collect()
}

impl SqlExecutor for Scripted {
    fn exec(&self, sql: &str, params: &[Value]) -> Result<Vec<Vec<Value>>, StoreError> {
        if !sql.starts_with("SELECT") {
            self.writes.set(self.writes.get() + 1);
            return Ok(Vec::new());
        }
        if sql.contains("sqlite_master") {
            return Ok(all_tables());
        }
        match params.get(1) {
            Some(Value::Text(key)) if key == META_STAMP => {
                Ok(vec![vec![Value::Blob(STAMP.to_vec())]])
            }
            Some(Value::Text(key)) if key == META_MANIFEST => Ok(self
                .manifest
                .iter()
                .map(|bytes| vec![Value::Blob(bytes.clone())])
                .collect()),
            _ => Ok(self.canned.borrow().clone()),
        }
    }
}

fn scripted(manifest: Option<Vec<u8>>) -> Scripted {
    Scripted {
        manifest,
        canned: Rc::default(),
        writes: Rc::default(),
    }
}

fn genesis() -> ironhorse_snapshot::store::CheckpointBatch {
    let image = ironhorse_vm::Interp::new()
        .snapshot_image(&Signature::new("ironhorse-store-do-test"))
        .unwrap();
    image_to_batch(&image, 1, CommitToken::ZERO)
}

fn manifest() -> Vec<u8> {
    genesis().manifest.encode()
}

fn malformed_answers() -> Vec<Vec<Vec<Value>>> {
    let blob = || Value::Blob(vec![1, 2, 3]);
    let mut answers = vec![
        vec![vec![]],
        vec![vec![Value::Null; 5]],
        vec![vec![blob(); 2], vec![blob(); 2]],
        vec![vec![blob(); 3]; 3],
    ];
    for width in 1..=3 {
        for value in [
            Value::Null,
            Value::Text("x".into()),
            Value::Integer(-1),
            Value::Integer(1 << 40),
        ] {
            answers.push(vec![vec![value; width]]);
        }
    }
    answers
}

#[test]
fn answers_that_contradict_the_schema_poison_without_panicking() {
    let executor = scripted(Some(manifest()));
    let canned = executor.canned.clone();
    let store = DoStore::open(executor, 1).unwrap();
    for answer in malformed_answers() {
        *canned.borrow_mut() = answer.clone();
        let results: [(&str, Result<(), StoreError>); 10] = [
            ("read_small_state", store.read_small_state().map(drop)),
            (
                "small_section_hashes",
                store.small_section_hashes().map(drop),
            ),
            ("read_slot_page", store.read_slot_page(0).map(drop)),
            ("read_chunk_extent", store.read_chunk_extent(0).map(drop)),
            ("read_free_seg", store.read_free_seg(0).map(drop)),
            ("inventory", store.inventory().map(drop)),
            ("page_edges", store.page_edges().map(drop)),
            ("summary_page_count", store.summary_page_count().map(drop)),
            (
                "reachable_page_set",
                store.reachable_page_set(&[0]).map(drop),
            ),
            ("failure", store.failure().map(drop)),
        ];
        for (method, result) in results {
            let error = result.expect_err(&format!("{method} refuses {answer:?}"));
            assert_eq!(
                error.classify(),
                StoreFailure::Poisoned,
                "{method} on {answer:?}: {error:?}"
            );
        }
    }
}

#[test]
fn a_malformed_stamp_table_or_manifest_answer_poisons() {
    /// Answers the table lookup with `tables` and every other `SELECT`
    /// with `stamp`.
    #[derive(Debug)]
    struct Stamp {
        tables: Vec<Vec<Value>>,
        stamp: Vec<Vec<Value>>,
    }
    impl SqlExecutor for Stamp {
        fn exec(&self, sql: &str, _: &[Value]) -> Result<Vec<Vec<Value>>, StoreError> {
            Ok(if sql.contains("sqlite_master") {
                self.tables.clone()
            } else if sql.starts_with("SELECT") {
                self.stamp.clone()
            } else {
                Vec::new()
            })
        }
    }
    for answer in malformed_answers()
        .into_iter()
        .chain([vec![vec![Value::Blob(b"NOPE".to_vec())]]])
    {
        let stamp = Stamp {
            tables: all_tables(),
            stamp: answer.clone(),
        };
        let error = DoStore::open(stamp, 1).expect_err("foreign stamp");
        assert_eq!(error.classify(), StoreFailure::Poisoned, "{answer:?}");
        let tables = Stamp {
            tables: answer.clone(),
            stamp: Vec::new(),
        };
        let error = DoStore::open(tables, 1).expect_err("malformed table lookup");
        assert_eq!(error.classify(), StoreFailure::Poisoned, "{answer:?}");
    }
    // A table lookup naming a table the store did not ask about.
    let stranger = Stamp {
        tables: vec![vec![text("ih_other")]],
        stamp: Vec::new(),
    };
    assert_eq!(
        DoStore::open(stranger, 1).unwrap_err(),
        corrupt("do sql: an unexpected table name")
    );
    let store = DoStore::open(scripted(Some(vec![1, 2, 3])), 1).unwrap();
    assert_eq!(
        store.manifest().unwrap_err().classify(),
        StoreFailure::Poisoned
    );
}

#[test]
fn store_id_zero_is_refused() {
    let error = DoStore::open(scripted(Some(manifest())), 0).expect_err("id 0");
    assert!(matches!(error, StoreError::Unsupported(_)));
    assert_eq!(error.classify(), StoreFailure::Refused);
}

#[test]
fn an_over_cap_value_is_a_deterministic_refusal() {
    assert_eq!(cap(&vec![0; MAX_VALUE_BYTES], MAX_VALUE_BYTES), Ok(()));
    let error = cap(&vec![0; MAX_VALUE_BYTES + 1], MAX_VALUE_BYTES).unwrap_err();
    assert_eq!(error, StoreError::Unsupported(CAP_REFUSAL));
    assert_eq!(error.classify(), StoreFailure::Refused);
    assert!(CAP_REFUSAL.contains("2,000,000"), "the text names the cap");
    assert_eq!(MAX_VALUE_BYTES, 2_000_000);
    const { assert!(SECTION_CHUNK_BYTES < MAX_VALUE_BYTES) };
}

#[test]
fn a_reason_is_cut_at_a_character_boundary_to_fit_the_cap() {
    const LIMIT: usize = 32;
    let cut = LIMIT - TRUNCATED.len();
    assert_eq!(fit_reason(&"a".repeat(LIMIT), LIMIT), "a".repeat(LIMIT));
    // A two-byte character straddling the cut is dropped whole.
    let straddling = format!("{}é{}", "a".repeat(cut - 1), "b".repeat(LIMIT));
    let fitted = fit_reason(&straddling, LIMIT);
    assert_eq!(fitted, format!("{}{TRUNCATED}", "a".repeat(cut - 1)));
    assert_eq!(fitted.len(), LIMIT - 1);
    // One ending exactly at the cut is kept.
    let ending = format!("{}é{}", "a".repeat(cut - 2), "b".repeat(LIMIT));
    assert_eq!(
        fit_reason(&ending, LIMIT),
        format!("{}é{TRUNCATED}", "a".repeat(cut - 2))
    );
    assert_eq!(fit_reason(&ending, LIMIT).len(), LIMIT);
    // A four-byte character over the cut, at every offset.
    for before in cut - 3..=cut {
        let reason = format!("{}\u{1F600}{}", "a".repeat(before), "b".repeat(LIMIT));
        let fitted = fit_reason(&reason, LIMIT);
        assert!(
            fitted.len() <= LIMIT && fitted.ends_with(TRUNCATED),
            "{before}"
        );
    }
}

/// A batch the store refuses itself is refused before the executor sees a
/// single write; so is a migration's replacement. The commit's cap is the
/// largest slot page, so every slot page (planned first) fits and a later
/// row does not; the migration's cap passes the first sections and not a
/// later one. A store that checked each value as it wrote it would have
/// written those before refusing.
#[test]
fn a_refusal_the_store_raises_comes_before_any_write() {
    let batch = genesis();
    let largest = |rows: &[(u32, Vec<u8>)]| rows.iter().map(|(_, b)| b.len()).max().unwrap();
    let limit = largest(&batch.slot_pages);
    assert!(
        largest(&batch.chunk_extents) > limit,
        "an extent is over the cap"
    );
    let executor = scripted(None);
    let writes = executor.writes.clone();
    let mut store = DoStore::open(executor, 1).unwrap();
    store.value_cap = limit;
    writes.set(0);
    assert_eq!(
        store.commit(&batch),
        Err(StoreError::Unsupported(CAP_REFUSAL))
    );
    assert_eq!(writes.get(), 0);

    let executor = scripted(Some(batch.manifest.encode()));
    let writes = executor.writes.clone();
    let mut store = DoStore::open(executor, 1).unwrap();
    store.value_cap = 100;
    writes.set(0);
    let small = merge_framed(None, &batch).unwrap();
    let sections = split_small_state(&small).unwrap();
    assert!(sections[0].len() < 100 && sections.iter().any(|s| s.len() > 100));
    assert_eq!(
        store.replace_for_migration(&batch.manifest, &batch.manifest, &small),
        Err(StoreError::Unsupported(CAP_REFUSAL))
    );
    assert_eq!(writes.get(), 0);
    // At the real cap the same commit writes.
    let executor = scripted(None);
    let writes = executor.writes.clone();
    let mut store = DoStore::open(executor, 1).unwrap();
    writes.set(0);
    store.commit(&batch).unwrap();
    assert!(writes.get() > 0);
}
