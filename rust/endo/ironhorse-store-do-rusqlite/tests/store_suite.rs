//! The engine's **store acceptance suite** (`ironhorse_snapshot::store_suite`)
//! against `DoStore` over real SQLite, mirroring the SQLite backend's
//! `tests/store_suite.rs`: all eight parts in memory, the ones a medium can
//! change on disk, the commit contract across a real reopen, and the
//! consistent-edit part with its rows edited through a second connection.
//!
//! Every fresh store is a new store id in one database, as several stores
//! share one Durable Object. Two variations run some of the suite's parts
//! again: with sections split into many 97-byte chunks, and through the host
//! imports' value encoding (`ironhorse_store_do::wire`) with every number
//! bound to SQLite as a REAL, as the Durable Object host binds JavaScript
//! numbers (see `Wired`).

use ironhorse_snapshot::store::StoreError;
use ironhorse_snapshot::store_suite::{
    boundary_collection_twins, checkpoint_acceptance, commit_contract, consistent_edits_resume,
    lazy_working_set_bound, metamorphic_suite, resume_equals_uninterrupted,
    sparse_section_acceptance,
};
use std::rc::Rc;

use ironhorse_store_do::{wire, DoStore, SqlExecutor, Value, SECTION_CHUNK_BYTES};
use ironhorse_store_do_rusqlite::RusqliteExecutor;
use rusqlite::{params, Connection};

mod common;
use common::{fresh_stores, rewrite_section, Store, TempDir};

fn in_memory() -> impl FnMut() -> Store {
    fresh_stores(RusqliteExecutor::open_in_memory().unwrap())
}

#[test]
fn do_in_memory_sparse_sections_match_full_snapshots() {
    sparse_section_acceptance(in_memory());
}

#[test]
fn do_in_memory_agrees_seven_ways() {
    metamorphic_suite(in_memory());
}

#[test]
fn do_in_memory_twins_agree_after_a_boundary_collection() {
    boundary_collection_twins(in_memory());
}

#[test]
fn do_in_memory_lazy_resume_faults_only_the_working_set() {
    lazy_working_set_bound(in_memory());
}

#[test]
fn do_in_memory_checkpoint_acceptance() {
    checkpoint_acceptance(&mut in_memory()());
}

#[test]
fn do_in_memory_resume_equals_uninterrupted() {
    resume_equals_uninterrupted(&mut in_memory()());
}

/// Fresh stores in one on-disk database under a test-owned temp dir.
fn with_disk_stores(name: &str, run: impl FnOnce(&mut dyn FnMut() -> Store)) {
    let dir = TempDir::new(&format!("ironhorse-do-suite-{name}"));
    let executor = RusqliteExecutor::open(dir.join("object.sqlite")).unwrap();
    run(&mut fresh_stores(executor));
}

#[test]
fn do_on_disk_sparse_sections_match_full_snapshots() {
    with_disk_stores("sparse", |fresh| sparse_section_acceptance(fresh));
}

#[test]
fn do_on_disk_agrees_seven_ways() {
    with_disk_stores("metamorphic", |fresh| metamorphic_suite(fresh));
}

#[test]
fn do_on_disk_lazy_resume_faults_only_the_working_set() {
    with_disk_stores("working-set", |fresh| lazy_working_set_bound(fresh));
}

#[test]
fn do_on_disk_twins_agree_after_a_boundary_collection() {
    with_disk_stores("boundary-collection", |fresh| {
        boundary_collection_twins(fresh)
    });
}

#[test]
fn do_on_disk_checkpoint_acceptance() {
    with_disk_stores("acceptance", |fresh| checkpoint_acceptance(&mut fresh()));
}

#[test]
fn do_on_disk_resume_equals_uninterrupted() {
    with_disk_stores("resume", |fresh| resume_equals_uninterrupted(&mut fresh()));
}

/// Reopen store `id` on a new connection to `path`, the old handle (and with
/// it the only connection) dropped first.
fn reopen(path: &std::path::Path, store: Store) -> Store {
    let id = store.id();
    drop(store);
    DoStore::open(RusqliteExecutor::open(path).unwrap(), id).unwrap()
}

#[test]
fn do_obeys_shared_commit_contract_across_a_real_reopen() {
    commit_contract(in_memory()(), |store| store);
    let dir = TempDir::new("ironhorse-do-commit-contract");
    let path = dir.join("object.sqlite");
    // Another store in the same database, so the reopen also shows that
    // stores keep to their own rows.
    let _neighbour = DoStore::open(RusqliteExecutor::open(&path).unwrap(), 1).unwrap();
    commit_contract(
        DoStore::open(RusqliteExecutor::open(&path).unwrap(), 2).unwrap(),
        |store| reopen(&path, store),
    );
}

/// The shared consistent-edit part, each row edited at rest through a second
/// connection between opens, in the layout the store keeps (`chunk_bytes`).
fn consistent_edits_on_disk(name: &str, chunk_bytes: usize) {
    let dir = TempDir::new(name);
    let path = dir.join("object.sqlite");
    let open = |id: u32| {
        DoStore::open(RusqliteExecutor::open(&path).unwrap(), id)
            .unwrap()
            .with_section_chunk_bytes(chunk_bytes)
            .unwrap()
    };
    consistent_edits_resume(open(3), |store, kind, index, _old, new| {
        let id = store.id();
        drop(store);
        let conn = Connection::open(&path).unwrap();
        let update = |table: &str, column: &str| {
            conn.execute(
                &format!("UPDATE {table} SET bytes = ?1 WHERE store = ?2 AND {column} = ?3"),
                params![new, id, index],
            )
            .unwrap()
        };
        let changed = match kind {
            "slot page" => update("ih_slot_pages", "page"),
            "chunk extent" => update("ih_chunk_exts", "ext"),
            "free segment" => update("ih_free_segs", "seg"),
            "small section" => {
                rewrite_section(&conn, id, index, new, chunk_bytes);
                1
            }
            "manifest" => conn
                .execute(
                    "UPDATE ih_meta SET value = ?1 WHERE store = ?2 AND key = 'manifest'",
                    params![new, id],
                )
                .unwrap(),
            other => panic!("no {other} rows here"),
        };
        assert_eq!(changed, 1, "{kind} {index}");
        conn.close().unwrap();
        open(id)
    });
}

#[test]
fn do_consistent_edits_at_rest_resume_as_the_machine_they_describe() {
    consistent_edits_on_disk("ironhorse-do-consistent-edits", SECTION_CHUNK_BYTES);
}

// Many chunks per section: 97 bytes, prime, so section lengths fall on and
// off chunk boundaries.
const SMALL_CHUNKS: usize = 97;

fn small_chunks() -> impl FnMut() -> Store {
    let mut fresh = in_memory();
    move || fresh().with_section_chunk_bytes(SMALL_CHUNKS).unwrap()
}

#[test]
fn do_with_small_chunks_checkpoint_acceptance() {
    checkpoint_acceptance(&mut small_chunks()());
}

#[test]
fn do_with_small_chunks_sparse_sections_match_full_snapshots() {
    sparse_section_acceptance(small_chunks());
}

#[test]
fn do_with_small_chunks_agrees_seven_ways() {
    metamorphic_suite(small_chunks());
}

#[test]
fn do_with_small_chunks_consistent_edits_resume() {
    consistent_edits_on_disk("ironhorse-do-small-chunk-edits", SMALL_CHUNKS);
}

/// The Durable Object host's side of the wire, over SQLite: parameters are
/// encoded by the guest and decoded, every number is bound as a REAL (`f64`),
/// as `sql.exec` binds a JavaScript number, so every comparison and insert
/// of an integer column meets a REAL parameter; result columns are read
/// back, INTEGER or REAL alike, as the numbers the host would return, and
/// encoded and decoded for the guest. What this does not cover: workerd's
/// own conversions between SQLite values and JavaScript ones.
#[derive(Clone, Debug)]
struct Wired(Rc<Connection>);

impl SqlExecutor for Wired {
    fn exec(&self, sql: &str, params: &[Value]) -> Result<Vec<Vec<Value>>, StoreError> {
        use rusqlite::types::{Value as Sql, ValueRef};
        let io = |e: rusqlite::Error| StoreError::Io(format!("sqlite: {e}"));
        let bound: Vec<Sql> = wire::decode_params(&wire::encode_params(params)?)?
            .into_iter()
            .map(|value| match value {
                Value::Null => Sql::Null,
                // Exact: the integer came off the wire as a double.
                Value::Integer(n) => Sql::Real(n as f64),
                Value::Blob(bytes) => Sql::Blob(bytes),
                Value::Text(text) => Sql::Text(text),
            })
            .collect();
        let mut statement = self.0.prepare_cached(sql).map_err(io)?;
        let width = statement.column_count();
        let mut rows = statement
            .query(rusqlite::params_from_iter(bound))
            .map_err(io)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(io)? {
            let mut values = Vec::with_capacity(width);
            for index in 0..width {
                values.push(match row.get_ref(index).map_err(io)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => Value::Integer(n),
                    ValueRef::Real(x) => Value::Integer(wire::f64_to_integer(x)?),
                    ValueRef::Text(text) => {
                        Value::Text(String::from_utf8(text.to_vec()).expect("UTF-8"))
                    }
                    ValueRef::Blob(bytes) => Value::Blob(bytes.to_vec()),
                });
            }
            out.push(values);
        }
        wire::decode_rows(&wire::encode_rows(&out)?)
    }
}

fn wired() -> impl FnMut() -> DoStore<Wired> {
    let conn = Connection::open_in_memory().unwrap();
    conn.set_prepared_statement_cache_capacity(128);
    let executor = Wired(Rc::new(conn));
    let mut next = 0u32;
    move || {
        next += 1;
        DoStore::open(executor.clone(), next).unwrap()
    }
}

#[test]
fn do_through_the_wire_checkpoint_acceptance() {
    checkpoint_acceptance(&mut wired()());
}

/// The REAL parameters land as integers: SQLite's INTEGER affinity converts
/// a REAL that carries one, so the keys the store compares stay integers.
#[test]
fn do_through_the_wire_keys_are_stored_as_integers() {
    let conn = Rc::new(Connection::open_in_memory().unwrap());
    let mut store = DoStore::open(Wired(conn.clone()), 1).unwrap();
    checkpoint_acceptance(&mut store);
    for (table, column) in [
        ("ih_meta", "store"),
        ("ih_slot_pages", "page"),
        ("ih_chunk_exts", "ext"),
        ("ih_free_segs", "seg"),
        ("ih_page_edges", "page"),
        ("ih_sections", "chunk"),
    ] {
        let types: Vec<String> = conn
            .prepare(&format!(
                "SELECT DISTINCT typeof(store) FROM {table} \
                 UNION SELECT DISTINCT typeof({column}) FROM {table}"
            ))
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        // This heap has an empty free list, so no free-list segment row.
        let expected: &[&str] = if table == "ih_free_segs" {
            &[]
        } else {
            &["integer"]
        };
        assert_eq!(types, expected, "{table}.{column}");
    }
}

#[test]
fn do_through_the_wire_sparse_sections_match_full_snapshots() {
    sparse_section_acceptance(wired());
}

#[test]
fn do_through_the_wire_obeys_the_commit_contract() {
    commit_contract(wired()(), |store| store);
}

#[test]
fn do_through_the_wire_resume_equals_uninterrupted() {
    resume_equals_uninterrupted(&mut wired()());
}
