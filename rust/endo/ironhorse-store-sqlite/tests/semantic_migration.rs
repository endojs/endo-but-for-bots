//! SQLite cross-version lock for semantic VM migrations. The committed store
//! was produced by exact commit `8047fd52f`, before the implicit `join`
//! dependency and current arguments-object representation landed.

mod common;

use common::TempDir;

use ironhorse_snapshot::machine::{checkpoint_to_store, resume_from_store};
use ironhorse_snapshot::Signature;
use ironhorse_store_sqlite::SqliteHeapStore;
use ironhorse_vm::{parse_symbols, Interp, RunOutcome};

fn signature() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn run(machine: &mut Interp, source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("crank compiles");
    let names = parse_symbols(&symbols);
    let bytecode = machine
        .relink_crank(&bytecode, &names)
        .expect("crank relinks");
    machine.run(&bytecode)
}

#[test]
fn old_sqlite_store_migrates_once_and_preserves_later_guest_edits() {
    let dir = TempDir::new("ih-sqlite-semantic-migration");
    let path = dir.join("compat.sqlite");
    std::fs::copy(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/compat-8047.sqlite"),
        &path,
    )
    .expect("copy exact-8047 fixture");

    let mut store = SqliteHeapStore::open(&path).expect("open old store");
    let mut session = resume_from_store(&store, &signature()).expect("restore old store");
    let outcome = run(
        session.machine_mut(),
        "var held; var seed; \
         var joined = '' + [seed, seed + 1]; \
         joined + '|' + \
           (Object.getPrototypeOf(held) === Object.prototype) + '|' + \
           Object.prototype.hasOwnProperty.call(held, Symbol.iterator) + '|' + \
           (held[Symbol.iterator] === Array.prototype.values) + '|' + \
           Array.from(held).join(':')",
    );
    assert!(
        outcome.completed,
        "migration observation: {:?}",
        outcome.halt
    );
    assert_eq!(outcome.result, "1,2|true|true|true|1:2");

    let outcome = run(
        session.machine_mut(),
        "var held; \
         delete Array.prototype.join; \
         Object.setPrototypeOf(held, Array.prototype); \
         delete held[Symbol.iterator]; \
         'edited'",
    );
    assert!(outcome.completed, "guest edits: {:?}", outcome.halt);
    assert_eq!(outcome.result, "edited");
    checkpoint_to_store(&mut session, &signature(), &mut store).expect("checkpoint migration");
    drop(session);
    store.close().expect("close migrated store");

    let store = SqliteHeapStore::open(&path).expect("reopen migrated store");
    let mut session = resume_from_store(&store, &signature()).expect("restore migrated store");
    let outcome = run(
        session.machine_mut(),
        "var held; \
         (typeof Array.prototype.join) + '|' + \
           (Object.getPrototypeOf(held) === Array.prototype) + '|' + \
           Object.prototype.hasOwnProperty.call(held, Symbol.iterator)",
    );
    assert!(outcome.completed, "second restore: {:?}", outcome.halt);
    assert_eq!(outcome.result, "undefined|true|false");
}
