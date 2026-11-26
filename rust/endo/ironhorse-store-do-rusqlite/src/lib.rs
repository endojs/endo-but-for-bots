//! [`RusqliteExecutor`]: an [`SqlExecutor`] over a rusqlite [`Connection`],
//! so [`ironhorse_store_do::DoStore`] runs natively against real SQLite. Its
//! tests run the engine's whole store acceptance suite against the Durable
//! Object store, and check the host contract that store relies on (one host
//! transaction around each committing call) with SQLite's own transactions.
//!
//! The executor keeps the Durable Object's discipline: one statement per
//! call (a second statement in the text is refused) and no transaction
//! statements of its own. Transactions are the caller's, as they are the
//! Durable Object host's.
//!
//! This crate lives in the root workspace, not in `rust/engine`, which stays
//! `forbid(unsafe_code)` and zero-C; SQLite's C is the same bundled rusqlite
//! the daemon already compiles.

// `StoreError` is the store trait's error type, which this crate does not
// choose; the engine workspace allows the same lint for it.
#![allow(clippy::result_large_err)]

use std::cell::RefCell;
use std::collections::HashSet;
use std::path::Path;
use std::rc::Rc;

use ironhorse_snapshot::store::StoreError;
use ironhorse_snapshot::SnapshotError;
use ironhorse_store_do::{wire, SqlExecutor, Value};
use rusqlite::types::{ToSqlOutput, ValueRef};
use rusqlite::{Connection, ToSql};

/// Map a rusqlite failure into the store vocabulary, as the SQLite backend
/// does: I/O-class, except a file that is not a database or whose pages are
/// malformed, which reads the same on every retry and so is a corrupt store.
fn sql_err(e: rusqlite::Error) -> StoreError {
    match e.sqlite_error_code() {
        Some(rusqlite::ErrorCode::NotADatabase) => {
            StoreError::Snapshot(SnapshotError::Corrupt("sqlite: not a database"))
        }
        Some(rusqlite::ErrorCode::DatabaseCorrupt) => StoreError::Snapshot(SnapshotError::Corrupt(
            "sqlite: database disk image is malformed",
        )),
        _ => StoreError::Io(format!("sqlite: {e}")),
    }
}

/// Prepared statements kept per connection: above the number of distinct
/// texts a store issues (about forty, counting each table's upsert, delete
/// and reads), so the cache does not churn; rusqlite's default is 16.
const STATEMENT_CACHE: usize = 128;

/// A parameter bound by reference.
struct Param<'a>(&'a Value);

impl ToSql for Param<'_> {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(match self.0 {
            Value::Null => ValueRef::Null,
            Value::Integer(n) => ValueRef::Integer(*n),
            Value::Blob(bytes) => ValueRef::Blob(bytes),
            Value::Text(text) => ValueRef::Text(text.as_bytes()),
        }))
    }
}

/// A column read back. A REAL is admitted only when it carries an integer,
/// as the Durable Object's doubles are ([`wire::f64_to_integer`]); the store
/// writes none.
fn column(value: ValueRef<'_>) -> Result<Value, StoreError> {
    Ok(match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => Value::Integer(n),
        ValueRef::Real(x) => Value::Integer(wire::f64_to_integer(x)?),
        ValueRef::Text(text) => Value::Text(String::from_utf8(text.to_vec()).map_err(|_| {
            StoreError::Snapshot(SnapshotError::Corrupt("sqlite: text is not UTF-8"))
        })?),
        ValueRef::Blob(bytes) => Value::Blob(bytes.to_vec()),
    })
}

/// Runs [`DoStore`](ironhorse_store_do::DoStore) statements on one SQLite
/// connection. Clones share the connection, so several stores can use one
/// database, as they do in one Durable Object.
#[derive(Clone, Debug)]
pub struct RusqliteExecutor {
    conn: Rc<Connection>,
    /// Statement texts already found to hold exactly one statement.
    single: Rc<RefCell<HashSet<String>>>,
}

impl RusqliteExecutor {
    pub fn new(conn: Connection) -> RusqliteExecutor {
        conn.set_prepared_statement_cache_capacity(STATEMENT_CACHE);
        RusqliteExecutor {
            conn: Rc::new(conn),
            single: Rc::default(),
        }
    }

    /// Open (creating if absent) the database at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<RusqliteExecutor, StoreError> {
        Ok(RusqliteExecutor::new(
            Connection::open(path).map_err(sql_err)?,
        ))
    }

    /// A private in-memory database.
    pub fn open_in_memory() -> Result<RusqliteExecutor, StoreError> {
        Ok(RusqliteExecutor::new(
            Connection::open_in_memory().map_err(sql_err)?,
        ))
    }

    /// The shared connection, for the caller's transactions.
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// Refuse text that holds more (or less) than one statement. rusqlite
    /// prepares the first statement of a text and ignores the rest unless
    /// its `extra_check` feature is on, which this crate does not turn on
    /// (it keeps the daemon's rusqlite features), so each distinct text is
    /// split once here.
    fn assert_single_statement(&self, sql: &str) -> Result<(), StoreError> {
        if self.single.borrow().contains(sql) {
            return Ok(());
        }
        let mut batch = rusqlite::Batch::new(&self.conn, sql);
        let first = batch.next().map_err(sql_err)?.is_some();
        if !first || batch.next().map_err(sql_err)?.is_some() {
            return Err(StoreError::Unsupported(
                "sqlite: an exec must carry exactly one statement",
            ));
        }
        self.single.borrow_mut().insert(sql.to_owned());
        Ok(())
    }
}

impl SqlExecutor for RusqliteExecutor {
    fn exec(&self, sql: &str, params: &[Value]) -> Result<Vec<Vec<Value>>, StoreError> {
        self.assert_single_statement(sql)?;
        let mut statement = self.conn.prepare_cached(sql).map_err(sql_err)?;
        let width = statement.column_count();
        let mut rows = statement
            .query(rusqlite::params_from_iter(params.iter().map(Param)))
            .map_err(sql_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(sql_err)? {
            let mut values = Vec::with_capacity(width);
            for index in 0..width {
                values.push(column(row.get_ref(index).map_err(sql_err)?)?);
            }
            out.push(values);
        }
        Ok(out)
    }
}
