use super::*;

use ironhorse_snapshot::machine::{begin_store_session, checkpoint_to_store, resume_from_store};
use ironhorse_snapshot::{export_to_container, MachineSnapshot};
use ironhorse_store_sqlite::SqliteHeapStore;
use ironhorse_vm::{parse_symbols, Interp};

#[path = "../../tests/common/mod.rs"]
mod common;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn crank(machine: &mut Interp, source: &str) -> String {
    let (code, names) = ironhorse_compile::compile_atoms(source).unwrap();
    let code = machine.relink_crank(&code, &parse_symbols(&names)).unwrap();
    let outcome = machine.run(&code);
    assert!(outcome.completed, "{:?}", outcome.halt);
    outcome.result
}

fn source() -> Vec<u8> {
    demo_source().unwrap()
}

fn plan(db: &Connection, value: i32) {
    let count = db
        .execute(
            "INSERT INTO integer_edits SELECT slot, record, ?1 FROM heap_slots
         WHERE is_free = 0 AND integer_value = 40414243",
            [value],
        )
        .unwrap();
    assert_eq!(
        count, 1,
        "fixture must locate exactly one shared scalar cell"
    );
}

#[test]
fn shared_closure_repair_survives_gc_sqlite_checkpoint_and_reopen() {
    let source = source();
    let db = inspect(&source, &sig()).unwrap();
    assert_eq!(apply(&source, &sig(), &db).unwrap(), source);
    plan(&db, 40414250);
    let candidate = apply(&source, &sig(), &db).unwrap();
    let before = read_validated_machine(&source, &sig())
        .unwrap()
        .into_image();
    let after = read_validated_machine(&candidate, &sig())
        .unwrap()
        .into_image();
    let changed: Vec<_> = before
        .slots
        .iter()
        .zip(&after.slots)
        .enumerate()
        .filter(|(_, (a, b))| a != b)
        .map(|(i, _)| i)
        .collect();
    assert_eq!(changed.len(), 1);
    let mut expected = before.clone();
    expected.slots[changed[0]].value = Payload::Integer(40414250);
    assert_eq!(
        after, expected,
        "all other heap and side state is unchanged"
    );

    let mut old = from_snapshot_bytes(&source, &sig()).unwrap();
    assert_eq!(crank(&mut old, "read()"), "40414243");
    let mut machine = from_snapshot_bytes(&candidate, &sig()).unwrap();
    assert_eq!(crank(&mut machine, "read()"), "40414250");
    assert_eq!(crank(&mut machine, "add()"), "40414251");
    assert_eq!(crank(&mut machine, "read()"), "40414251");
    machine.collect_garbage();
    assert_eq!(crank(&mut machine, "read()"), "40414251");

    let dir = common::TempDir::new("vat-surgery-roundtrip");
    let path = dir.join("candidate.sqlite");
    let mut store = SqliteHeapStore::open(&path).unwrap();
    let mut session = begin_store_session(machine, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .unwrap();
    assert_eq!(crank(session.machine_mut(), "add()"), "40414252");
    checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
    let exported = export_to_container(&store).unwrap();
    drop(session);
    store.close().unwrap();
    let store = SqliteHeapStore::open(&path).unwrap();
    assert_eq!(export_to_container(&store).unwrap(), exported);
    let mut session = resume_from_store(&store, &sig()).unwrap();
    assert_eq!(crank(session.machine_mut(), "read()"), "40414252");
    assert_eq!(crank(session.machine_mut(), "add()"), "40414253");
    assert_eq!(crank(session.machine_mut(), "read()"), "40414253");
    drop(session);
    store.close().unwrap();
}

#[test]
fn refuses_stale_digest_record_wrong_kind_and_out_of_range_slot() {
    let source = source();
    let db = inspect(&source, &sig()).unwrap();
    plan(&db, 17);
    let candidate = apply(&source, &sig(), &db).unwrap();
    assert!(apply(&candidate, &sig(), &db)
        .unwrap_err()
        .to_string()
        .contains("digest mismatch"));
    db.execute(
        "UPDATE integer_edits SET expected_record = zeroblob(20)",
        [],
    )
    .unwrap();
    assert!(apply(&source, &sig(), &db)
        .unwrap_err()
        .to_string()
        .contains("record mismatch"));
    db.execute("DELETE FROM integer_edits", []).unwrap();
    db.execute("INSERT INTO integer_edits SELECT slot, record, 1 FROM heap_slots WHERE kind != 'Integer' AND is_free = 0 LIMIT 1", []).unwrap();
    assert!(apply(&source, &sig(), &db)
        .unwrap_err()
        .to_string()
        .contains("not an Integer"));
    db.execute("UPDATE integer_edits SET slot = 4294967295", [])
        .unwrap();
    assert!(apply(&source, &sig(), &db)
        .unwrap_err()
        .to_string()
        .contains("out of range"));
}

#[test]
fn integer_limits_and_tampered_sql_schema() {
    let source = source();
    for value in [i32::MIN, i32::MAX] {
        let db = inspect(&source, &sig()).unwrap();
        plan(&db, value);
        let candidate = apply(&source, &sig(), &db).unwrap();
        let mut machine = from_snapshot_bytes(&candidate, &sig()).unwrap();
        assert_eq!(crank(&mut machine, "read()"), value.to_string());
    }
    let db = inspect(&source, &sig()).unwrap();
    db.execute_batch(
        "DROP TABLE integer_edits; CREATE TABLE integer_edits(slot, expected_record, replacement)",
    )
    .unwrap();
    for literal in ["2147483648", "-2147483649", "1.5", "'hello'", "NULL"] {
        db.execute("DELETE FROM integer_edits", []).unwrap();
        db.execute(&format!("INSERT INTO integer_edits SELECT slot, record, {literal} FROM heap_slots WHERE integer_value = 40414243 AND is_free = 0"), []).unwrap();
        assert!(apply(&source, &sig(), &db).is_err(), "{literal}");
    }
    db.execute("DELETE FROM integer_edits", []).unwrap();
    plan(&db, 1);
    db.execute("INSERT INTO integer_edits SELECT * FROM integer_edits", [])
        .unwrap();
    assert!(apply(&source, &sig(), &db)
        .unwrap_err()
        .to_string()
        .contains("duplicate"));
    db.execute("DELETE FROM integer_edits", []).unwrap();
    db.execute("UPDATE snapshot SET source_sha256 = 'wrong'", [])
        .unwrap();
    assert!(apply(&source, &sig(), &db).is_err());
}

#[test]
fn refuses_free_slots_and_wrong_runtime_profile() {
    let mut machine = from_snapshot_bytes(&source(), &sig()).unwrap();
    let index = machine.slots.alloc(ironhorse_vm::Slot::integer(42));
    machine.slots.free(index);
    let source = machine.write_snapshot(&sig()).unwrap();
    let db = inspect(&source, &sig()).unwrap();
    assert_eq!(db.execute("INSERT INTO integer_edits SELECT slot, record, 1 FROM heap_slots WHERE slot = ?1 AND is_free = 1", [index.0]).unwrap(), 1);
    assert!(apply(&source, &sig(), &db)
        .unwrap_err()
        .to_string()
        .contains("free slot"));
    assert!(inspect(&source, &Signature::new("foreign-worker")).is_err());
    assert!(apply(&source, &Signature::new("foreign-worker"), &db).is_err());
}

#[test]
fn cli_preserves_sources_and_existing_outputs_and_rejects_whole_bad_batch() {
    let dir = common::TempDir::new("vat-surgery-cli");
    let input = dir.join("source.container");
    let workspace = dir.join("workspace.sqlite");
    let output = dir.join("candidate.container");
    let source = source();
    fs::write(&input, &source).unwrap();
    let inspect_args = vec![
        "inspect".into(),
        input.display().to_string(),
        workspace.display().to_string(),
        "ironhorse-worker-v1".into(),
    ];
    run(&inspect_args).unwrap();
    assert!(run(&inspect_args).is_err());
    let apply_args = vec![
        "apply".into(),
        input.display().to_string(),
        workspace.display().to_string(),
        output.display().to_string(),
        "ironhorse-worker-v1".into(),
    ];
    let db = Connection::open(&workspace).unwrap();
    plan(&db, 42);
    // A later invalid edit must not publish the earlier valid edit.
    db.execute(
        "INSERT INTO integer_edits VALUES (4294967295, zeroblob(20), 1)",
        [],
    )
    .unwrap();
    assert!(run(&apply_args).is_err());
    assert!(!output.exists());
    db.execute("DELETE FROM integer_edits WHERE slot = 4294967295", [])
        .unwrap();
    drop(db);
    run(&apply_args).unwrap();
    let prior_output = fs::read(&output).unwrap();
    assert!(run(&apply_args).is_err());
    assert_eq!(fs::read(&output).unwrap(), prior_output);
    assert_eq!(fs::read(&input).unwrap(), source);
}
