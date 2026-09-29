//! SQLite host functions.
//!
//! Provides database access through handle-based APIs following the
//! same pattern as `DIR_MAP` / `FILE_MAP` / `HASHER_MAP`.
//!
//! JS calling convention:
//!   sqliteOpen(path) -> number (handle) or "Error: ..."
//!   sqliteClose(dbH) -> undefined
//!   sqliteExec(dbH, sql) -> undefined or "Error: ..."
//!   sqlitePrepare(dbH, sql) -> number (handle) or "Error: ..."
//!   sqliteStmtRun(stmtH, paramsJson) -> JSON {changes, lastInsertRowid}
//!   sqliteStmtGet(stmtH, paramsJson) -> JSON object, "null", or error
//!   sqliteStmtAll(stmtH, paramsJson) -> JSON array or error
//!   sqliteStmtColumns(stmtH) -> JSON array of {name, type}
//!   sqliteStmtFinalize(stmtH) -> undefined
//!
//! Type mapping (SQLite → FFI JSON → JS):
//!   NULL    → null         → null
//!   INTEGER → {$bigint: s} → bigint
//!   REAL    → number       → number
//!   TEXT    → string       → string
//!   BLOB    → {$bytes: b}  → Uint8Array (base64 in JSON)

use crate::ffi::*;
use crate::host_ledger::{self, Descriptor, Outcome};
use crate::worker_io::{abort_if_ffi_panicked, arg_str, set_result_string};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rusqlite::{types::Value as SqlValue, Connection};
use serde_json::{json, Map, Value as JsonValue};
use slot_machine_transcript::HostClass;
use std::cell::RefCell;
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Handle maps
// ---------------------------------------------------------------------------
//
// Handle tables belong to the dedicated worker thread. A caught callback panic
// cannot expose a torn mutation to a sibling worker, and thread exit drops all
// remaining native resources. `host_ledger::call` allocates the ids.
thread_local! {
    static DB_MAP: RefCell<HashMap<u32, Connection>> = RefCell::new(HashMap::new());
}

thread_local! {
    static STMT_MAP: RefCell<HashMap<u32, PreparedStmt>> = RefCell::new(HashMap::new());
}

struct PreparedStmt {
    db_handle: u32,
    sql: String,
}

/// Convert a JSON parameter value to a rusqlite `Value`.
fn json_to_sql(v: &JsonValue) -> Result<SqlValue, String> {
    match v {
        JsonValue::Null => Ok(SqlValue::Null),
        JsonValue::Bool(b) => Ok(SqlValue::Integer(if *b { 1 } else { 0 })),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(SqlValue::Integer(i))
            } else if let Some(f) = n.as_f64() {
                Ok(SqlValue::Real(f))
            } else {
                Err("Error: unsupported number value".to_string())
            }
        }
        JsonValue::String(s) => Ok(SqlValue::Text(s.clone())),
        JsonValue::Object(obj) => {
            if let Some(JsonValue::String(s)) = obj.get("$bigint") {
                let i: i64 = s
                    .parse()
                    .map_err(|_| format!("Error: invalid $bigint value: {}", s))?;
                Ok(SqlValue::Integer(i))
            } else if let Some(JsonValue::String(s)) = obj.get("$bytes") {
                let bytes = BASE64
                    .decode(s)
                    .map_err(|_| "Error: invalid $bytes base64".to_string())?;
                Ok(SqlValue::Blob(bytes))
            } else {
                Err("Error: unsupported object parameter".to_string())
            }
        }
        JsonValue::Array(_) => Err("Error: array parameters not supported".to_string()),
    }
}

/// Convert a rusqlite `Value` to a JSON value using FFI tags.
fn sql_to_json(v: SqlValue) -> JsonValue {
    match v {
        SqlValue::Null => JsonValue::Null,
        SqlValue::Integer(i) => json!({"$bigint": i.to_string()}),
        SqlValue::Real(f) => json!(f),
        SqlValue::Text(s) => JsonValue::String(s),
        SqlValue::Blob(b) => json!({"$bytes": BASE64.encode(&b)}),
    }
}

/// Parse JSON params string into a vec of rusqlite values.
/// Supports positional (JSON array) and named (JSON object) params.
fn parse_params(json_str: &str) -> Result<ParamSet, String> {
    let parsed: JsonValue =
        serde_json::from_str(json_str).map_err(|e| format!("Error: invalid params JSON: {}", e))?;
    match parsed {
        JsonValue::Null => Ok(ParamSet::Positional(vec![])),
        JsonValue::Array(arr) => {
            let mut vals = Vec::with_capacity(arr.len());
            for v in &arr {
                vals.push(json_to_sql(v)?);
            }
            Ok(ParamSet::Positional(vals))
        }
        JsonValue::Object(obj) => {
            let mut named = Vec::with_capacity(obj.len());
            for (k, v) in &obj {
                named.push((k.clone(), json_to_sql(v)?));
            }
            Ok(ParamSet::Named(named))
        }
        _ => Err("Error: params must be null, array, or object".to_string()),
    }
}

enum ParamSet {
    Positional(Vec<SqlValue>),
    Named(Vec<(String, SqlValue)>),
}

/// Execute a statement with parsed params and return the rusqlite statement result.
fn execute_stmt(conn: &Connection, sql: &str, params: &ParamSet) -> Result<usize, rusqlite::Error> {
    let mut stmt = conn.prepare(sql)?;
    match params {
        ParamSet::Positional(vals) => {
            let refs: Vec<&dyn rusqlite::types::ToSql> = vals
                .iter()
                .map(|v| v as &dyn rusqlite::types::ToSql)
                .collect();
            stmt.execute(refs.as_slice())
        }
        ParamSet::Named(vals) => {
            let pairs: Vec<(&str, &dyn rusqlite::types::ToSql)> = vals
                .iter()
                .map(|(k, v)| (k.as_str(), v as &dyn rusqlite::types::ToSql))
                .collect();
            stmt.execute(pairs.as_slice())
        }
    }
}

/// Query a single row.
fn query_get(conn: &Connection, sql: &str, params: &ParamSet) -> Result<Option<JsonValue>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| format!("Error: {}", e))?;
    let col_count = stmt.column_count();
    let col_names: Vec<String> = (0..col_count)
        .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
        .collect();

    let result = match params {
        ParamSet::Positional(vals) => {
            let refs: Vec<&dyn rusqlite::types::ToSql> = vals
                .iter()
                .map(|v| v as &dyn rusqlite::types::ToSql)
                .collect();
            stmt.query_row(refs.as_slice(), |row| {
                let mut obj = Map::new();
                for (i, name) in col_names.iter().enumerate() {
                    let val: SqlValue = row.get(i)?;
                    obj.insert(name.clone(), sql_to_json(val));
                }
                Ok(JsonValue::Object(obj))
            })
        }
        ParamSet::Named(vals) => {
            let pairs: Vec<(&str, &dyn rusqlite::types::ToSql)> = vals
                .iter()
                .map(|(k, v)| (k.as_str(), v as &dyn rusqlite::types::ToSql))
                .collect();
            stmt.query_row(pairs.as_slice(), |row| {
                let mut obj = Map::new();
                for (i, name) in col_names.iter().enumerate() {
                    let val: SqlValue = row.get(i)?;
                    obj.insert(name.clone(), sql_to_json(val));
                }
                Ok(JsonValue::Object(obj))
            })
        }
    };

    match result {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("Error: {}", e)),
    }
}

/// Query all rows.
fn query_all(conn: &Connection, sql: &str, params: &ParamSet) -> Result<JsonValue, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| format!("Error: {}", e))?;
    let col_count = stmt.column_count();
    let col_names: Vec<String> = (0..col_count)
        .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
        .collect();

    let map_row = |row: &rusqlite::Row| -> rusqlite::Result<JsonValue> {
        let mut obj = Map::new();
        for (i, name) in col_names.iter().enumerate() {
            let val: SqlValue = row.get(i)?;
            obj.insert(name.clone(), sql_to_json(val));
        }
        Ok(JsonValue::Object(obj))
    };

    let rows_result = match params {
        ParamSet::Positional(vals) => {
            let refs: Vec<&dyn rusqlite::types::ToSql> = vals
                .iter()
                .map(|v| v as &dyn rusqlite::types::ToSql)
                .collect();
            stmt.query_map(refs.as_slice(), map_row)
        }
        ParamSet::Named(vals) => {
            let pairs: Vec<(&str, &dyn rusqlite::types::ToSql)> = vals
                .iter()
                .map(|(k, v)| (k.as_str(), v as &dyn rusqlite::types::ToSql))
                .collect();
            stmt.query_map(pairs.as_slice(), map_row)
        }
    };

    let rows_iter = rows_result.map_err(|e| format!("Error: {}", e))?;
    let mut rows = Vec::new();
    for row in rows_iter {
        rows.push(row.map_err(|e| format!("Error: {}", e))?);
    }
    Ok(JsonValue::Array(rows))
}

// ---------------------------------------------------------------------------
// Host functions
// ---------------------------------------------------------------------------

/// Open a connection with the default pragmas.
fn open_connection(path: &str) -> Result<Connection, String> {
    let conn = if path == ":memory:" {
        Connection::open_in_memory()
    } else {
        Connection::open(path)
    }
    .map_err(|e| format!("Error: {}", e))?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(|e| format!("Error: {}", e))?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|e| format!("Error: {}", e))?;
    Ok(conn)
}

unsafe fn set_result_handle(the: *mut XsMachine, handle: u32) {
    fxInteger(the, &mut (*the).scratch, handle as i32);
    *(*the).frame.add(1) = (*the).scratch;
}

/// Set the guest's result to `text` (when there is one) and record it as
/// the reply.
unsafe fn reply(the: *mut XsMachine, text: Option<String>) -> Outcome {
    match text {
        Some(text) => {
            set_result_string(the, &text);
            Outcome {
                reply: text.into_bytes(),
                ..Outcome::default()
            }
        }
        None => Outcome::default(),
    }
}

/// Read a handle argument.
unsafe fn arg_handle(the: *mut XsMachine, index: usize) -> u32 {
    let handle = fxToInteger(the, (*the).frame.sub(1 + index)) as u32;
    abort_if_ffi_panicked();
    handle
}

/// Run a statement-handle callback: look up the statement and its
/// connection, and answer with `op`'s text.
///
/// # Safety
/// `the` must be valid with the callback's arguments.
unsafe fn with_statement(
    the: *mut XsMachine,
    callback: &str,
    params: bool,
    op: impl FnOnce(&Connection, &str, &ParamSet) -> String,
) {
    let stmt_handle = arg_handle(the, 0);
    let params_json = if params {
        arg_str(the, 1)
    } else {
        String::new()
    };
    let request = format!("{stmt_handle},{params_json}").into_bytes();
    let result = host_ledger::call(callback, Some(stmt_handle), &request, || {
        let text = STMT_MAP.with(|stmts| {
            let Some((db_handle, sql)) = stmts
                .borrow()
                .get(&stmt_handle)
                .map(|s| (s.db_handle, s.sql.clone()))
            else {
                return format!("Error: invalid statement handle {}", stmt_handle);
            };
            let params = if params {
                match parse_params(&params_json) {
                    Ok(p) => p,
                    Err(e) => return e,
                }
            } else {
                ParamSet::Positional(Vec::new())
            };
            DB_MAP.with(|dbs| match dbs.borrow().get(&db_handle) {
                Some(conn) => op(conn, &sql, &params),
                None => format!("Error: invalid database handle {}", db_handle),
            })
        });
        reply(the, Some(text))
    });
    if let Err(msg) = result {
        set_result_string(the, &msg);
    }
}

/// `sqliteOpen(path) -> number | "Error: ..."`
///
/// An in-memory database has no reconstruction descriptor: its handle is
/// re-seated as broken.
pub unsafe extern "C" fn host_sqlite_open(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        let path = arg_str(the, 0);
        let mut opened = None;
        let result = host_ledger::call(
            "sqliteOpen",
            None,
            path.as_bytes(),
            || match open_connection(&path) {
                Ok(conn) => {
                    opened = Some(conn);
                    let descriptor =
                        (path != ":memory:").then(|| Descriptor::Database { path: path.clone() });
                    Outcome {
                        opens: Some(descriptor),
                        ..Outcome::default()
                    }
                }
                Err(e) => reply(the, Some(e)),
            },
        );
        match (result, opened) {
            (Ok(Some(handle)), Some(conn)) => {
                DB_MAP.with(|m| m.borrow_mut().insert(handle, conn));
                set_result_handle(the, handle);
            }
            (Err(msg), _) => set_result_string(the, &msg),
            _ => {}
        }
    });
}

/// `sqliteClose(dbH) -> undefined`
pub unsafe extern "C" fn host_sqlite_close(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        let handle = arg_handle(the, 0);
        let request = handle.to_string().into_bytes();
        let _ = host_ledger::call("sqliteClose", Some(handle), &request, || {
            // Remove associated statements first.
            let mut also_closes = Vec::new();
            STMT_MAP.with(|stmts| {
                stmts.borrow_mut().retain(|id, s| {
                    let keep = s.db_handle != handle;
                    if !keep {
                        also_closes.push(*id);
                    }
                    keep
                })
            });
            also_closes.sort_unstable();
            // Then remove the connection.
            let closes = DB_MAP.with(|dbs| dbs.borrow_mut().remove(&handle).is_some());
            Outcome {
                closes,
                also_closes,
                ..Outcome::default()
            }
        });
    });
}

/// `sqliteExec(dbH, sql) -> undefined | "Error: ..."`
pub unsafe extern "C" fn host_sqlite_exec(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        let handle = arg_handle(the, 0);
        let sql = arg_str(the, 1);
        let request = format!("{handle},{sql}").into_bytes();
        let result = host_ledger::call("sqliteExec", Some(handle), &request, || {
            let text = DB_MAP.with(|dbs| match dbs.borrow().get(&handle) {
                Some(conn) => conn
                    .execute_batch(&sql)
                    .err()
                    .map(|e| format!("Error: {}", e)),
                None => Some(format!("Error: invalid database handle {}", handle)),
            });
            reply(the, text)
        });
        if let Err(msg) = result {
            set_result_string(the, &msg);
        }
    });
}

/// `sqlitePrepare(dbH, sql) -> number | "Error: ..."`
pub unsafe extern "C" fn host_sqlite_prepare(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        let db_handle = arg_handle(the, 0);
        let sql = arg_str(the, 1);
        let request = format!("{db_handle},{sql}").into_bytes();
        let mut prepared = false;
        let result = host_ledger::call("sqlitePrepare", Some(db_handle), &request, || {
            // Validate that the db handle exists.
            if !DB_MAP.with(|dbs| dbs.borrow().contains_key(&db_handle)) {
                return reply(
                    the,
                    Some(format!("Error: invalid database handle {}", db_handle)),
                );
            }
            prepared = true;
            Outcome {
                opens: Some(Some(Descriptor::Statement {
                    database: db_handle,
                    sql: sql.clone(),
                })),
                ..Outcome::default()
            }
        });
        match result {
            Ok(Some(stmt_handle)) if prepared => {
                STMT_MAP.with(|m| {
                    m.borrow_mut()
                        .insert(stmt_handle, PreparedStmt { db_handle, sql })
                });
                set_result_handle(the, stmt_handle);
            }
            Err(msg) => set_result_string(the, &msg),
            _ => {}
        }
    });
}

/// `sqliteStmtRun(stmtH, paramsJson) -> JSON | "Error: ..."`
pub unsafe extern "C" fn host_sqlite_stmt_run(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        with_statement(
            the,
            "sqliteStmtRun",
            true,
            |conn, sql, params| match execute_stmt(conn, sql, params) {
                Ok(changes) => format!(
                    "{{\"changes\":\"{}\",\"lastInsertRowid\":\"{}\"}}",
                    changes,
                    conn.last_insert_rowid()
                ),
                Err(e) => format!("Error: {}", e),
            },
        );
    });
}

/// `sqliteStmtGet(stmtH, paramsJson) -> JSON | "null" | "Error: ..."`
pub unsafe extern "C" fn host_sqlite_stmt_get(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        with_statement(
            the,
            "sqliteStmtGet",
            true,
            |conn, sql, params| match query_get(conn, sql, params) {
                Ok(Some(row)) => row.to_string(),
                Ok(None) => "null".to_string(),
                Err(e) => e,
            },
        );
    });
}

/// `sqliteStmtAll(stmtH, paramsJson) -> JSON | "Error: ..."`
pub unsafe extern "C" fn host_sqlite_stmt_all(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        with_statement(
            the,
            "sqliteStmtAll",
            true,
            |conn, sql, params| match query_all(conn, sql, params) {
                Ok(rows) => rows.to_string(),
                Err(e) => e,
            },
        );
    });
}

/// `sqliteStmtColumns(stmtH) -> JSON | "Error: ..."`
pub unsafe extern "C" fn host_sqlite_stmt_columns(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        with_statement(the, "sqliteStmtColumns", false, |conn, sql, _| {
            match conn.prepare(sql) {
                Ok(stmt) => {
                    // column_type() requires an executed statement, and the
                    // JS side does not need the declared type, so it is null.
                    let cols: Vec<JsonValue> = (0..stmt.column_count())
                        .map(|i| json!({"name": stmt.column_name(i).unwrap_or("?"), "type": null}))
                        .collect();
                    JsonValue::Array(cols).to_string()
                }
                Err(e) => format!("Error: {}", e),
            }
        });
    });
}

/// `sqliteStmtFinalize(stmtH) -> undefined`
pub unsafe extern "C" fn host_sqlite_stmt_finalize(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        let stmt_handle = arg_handle(the, 0);
        let request = stmt_handle.to_string().into_bytes();
        let _ = host_ledger::call("sqliteStmtFinalize", Some(stmt_handle), &request, || {
            Outcome {
                closes: STMT_MAP.with(|m| m.borrow_mut().remove(&stmt_handle).is_some()),
                ..Outcome::default()
            }
        });
    });
}

/// Native handles cannot be serialized with the XS heap.
pub(crate) fn has_open_handles() -> bool {
    DB_MAP.with(|map| !map.borrow().is_empty()) || STMT_MAP.with(|map| !map.borrow().is_empty())
}

/// Rebuild a database or statement handle from its descriptor under the
/// same logical id. A statement needs its database re-seated first, which
/// id order guarantees.
pub(crate) fn reseat(handle: u32, descriptor: &Descriptor) -> Result<(), String> {
    match descriptor {
        Descriptor::Database { path } => {
            let conn = open_connection(path)?;
            DB_MAP.with(|m| m.borrow_mut().insert(handle, conn));
        }
        Descriptor::Statement { database, sql } => {
            if !DB_MAP.with(|m| m.borrow().contains_key(database)) {
                return Err(format!("database handle {database} was not re-seated"));
            }
            STMT_MAP.with(|m| {
                m.borrow_mut().insert(
                    handle,
                    PreparedStmt {
                        db_handle: *database,
                        sql: sql.clone(),
                    },
                )
            });
        }
        _ => return Err("not a database or statement descriptor".into()),
    }
    Ok(())
}

/// Every callback in [`CALLBACKS`], by guest name, with its host-call
/// classification. The guest's databases are not the worker's transcript,
/// so a write cannot join the crank commit and is a barrier.
pub const CLASSES: &[(&str, HostClass)] = &[
    ("sqliteOpen", HostClass::Barrier),
    ("sqliteClose", HostClass::Read),
    ("sqliteExec", HostClass::Barrier),
    ("sqlitePrepare", HostClass::Read),
    ("sqliteStmtRun", HostClass::Barrier),
    ("sqliteStmtGet", HostClass::Read),
    ("sqliteStmtAll", HostClass::Read),
    ("sqliteStmtColumns", HostClass::Read),
    ("sqliteStmtFinalize", HostClass::Read),
];

/// All host callbacks in registration order for snapshot tables.
pub const CALLBACKS: &[crate::ffi::XsCallback] = &[
    host_sqlite_open,
    host_sqlite_close,
    host_sqlite_exec,
    host_sqlite_prepare,
    host_sqlite_stmt_run,
    host_sqlite_stmt_get,
    host_sqlite_stmt_all,
    host_sqlite_stmt_columns,
    host_sqlite_stmt_finalize,
];

/// Register all SQLite host functions on the machine.
pub unsafe fn register(machine: &crate::Machine) {
    machine.define_function("sqliteOpen", host_sqlite_open, 1);
    machine.define_function("sqliteClose", host_sqlite_close, 1);
    machine.define_function("sqliteExec", host_sqlite_exec, 2);
    machine.define_function("sqlitePrepare", host_sqlite_prepare, 2);
    machine.define_function("sqliteStmtRun", host_sqlite_stmt_run, 2);
    machine.define_function("sqliteStmtGet", host_sqlite_stmt_get, 2);
    machine.define_function("sqliteStmtAll", host_sqlite_stmt_all, 2);
    machine.define_function("sqliteStmtColumns", host_sqlite_stmt_columns, 1);
    machine.define_function("sqliteStmtFinalize", host_sqlite_stmt_finalize, 1);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_panic_isolates_database_handles_and_releases_transaction_locks() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("worker.sqlite");
        let worker_path = path.clone();
        std::thread::spawn(move || {
            crate::worker_io::guard_ffi(|| {
                DB_MAP.with(|dbs| {
                    let mut dbs = dbs.borrow_mut();
                    let db = Connection::open(worker_path).unwrap();
                    db.execute_batch(
                        "CREATE TABLE data (value); BEGIN EXCLUSIVE; INSERT INTO data VALUES (1)",
                    )
                    .unwrap();
                    dbs.insert(42, db);
                    STMT_MAP.with(|stmts| {
                        stmts.borrow_mut().insert(
                            42,
                            PreparedStmt {
                                db_handle: 42,
                                sql: "SELECT * FROM data".into(),
                            },
                        );
                    });
                    std::thread::spawn(|| {
                        DB_MAP.with(|dbs| assert!(!dbs.borrow().contains_key(&42)));
                        STMT_MAP.with(|stmts| assert!(!stmts.borrow().contains_key(&42)));
                    })
                    .join()
                    .unwrap();
                    panic!("database mutation panic");
                });
            });
            assert!(crate::worker_io::ffi_panicked());
        })
        .join()
        .unwrap();
        let db = Connection::open(path).unwrap();
        db.busy_timeout(std::time::Duration::ZERO).unwrap();
        db.execute_batch("BEGIN EXCLUSIVE; INSERT INTO data VALUES (2); COMMIT")
            .unwrap();
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM data", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "dead worker transaction must roll back on close");
    }
}
