//! The host-import ABI: one SQL statement per call, values tagged, no
//! transaction statements and no re-entry into the guest. The host owns the
//! Durable Object's `ctx.storage.sql`; the guest sees rows as bytes it copies
//! into memory it allocated itself, so an import never calls back into wasm
//! (the reentrant `tx(fn_id)` of the design's §6.1 is deliberately absent:
//! the host wraps a whole crank in `transactionSync`).
//!
//! Wire encoding, both directions, little-endian:
//!
//! - a value is one tag byte then its payload: `0` null, `1` an f64 (8
//!   bytes; integers travel as doubles, exact within u32), `2` a blob (u32
//!   length, bytes), `3` text (u32 length, UTF-8);
//! - the parameters of a call are a sequence of values;
//! - a result is a u32 row count, then per row a u32 column count and that
//!   many values.
//!
//! `host_exec` runs the statement and answers the encoded result's length,
//! or a negative error code with the error text pending instead; the guest
//! then allocates and calls `host_take` to copy whichever is pending. A JS
//! exception inside the host is caught there and reported as a code, never
//! thrown through the wasm frame.

use ironhorse_snapshot::store::StoreError;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C-unwind" {
    fn host_exec(sql_ptr: *const u8, sql_len: u32, params_ptr: *const u8, params_len: u32) -> i32;
    fn host_take(dst: *mut u8, cap: u32) -> u32;
    fn host_log(ptr: *const u8, len: u32);
    fn host_random(dst: *mut u8, len: u32);
}

// A native build only type-checks (`cargo check`); the imports are satisfied
// by the Durable Object host alone.
#[cfg(not(target_arch = "wasm32"))]
#[allow(clippy::missing_safety_doc)]
mod native_stubs {
    pub unsafe fn host_exec(_: *const u8, _: u32, _: *const u8, _: u32) -> i32 {
        unimplemented!("the host imports exist only in the Durable Object")
    }
    pub unsafe fn host_take(_: *mut u8, _: u32) -> u32 {
        unimplemented!("the host imports exist only in the Durable Object")
    }
    pub unsafe fn host_log(_: *const u8, _: u32) {}
    pub unsafe fn host_random(_: *mut u8, _: u32) {
        unimplemented!("the host imports exist only in the Durable Object")
    }
}
#[cfg(not(target_arch = "wasm32"))]
use native_stubs::{host_exec, host_log, host_random, host_take};

/// A bound parameter or a returned column.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Number(f64),
    Blob(Vec<u8>),
    Text(String),
}

impl Value {
    pub fn u32(n: u32) -> Value {
        Value::Number(f64::from(n))
    }

    /// An integer column read back as a double, range-checked into u32
    /// instead of truncated: a foreign writer's negative, fractional or
    /// oversized value fails closed like a malformed blob would.
    pub fn as_u32(&self, what: &'static str) -> Result<u32, StoreError> {
        match self {
            Value::Number(n) if n.fract() == 0.0 && *n >= 0.0 && *n <= f64::from(u32::MAX) => {
                Ok(*n as u32)
            }
            other => Err(StoreError::Io(format!(
                "do sql: {what} column out of range ({other:?})"
            ))),
        }
    }

    pub fn into_blob(self, what: &'static str) -> Result<Vec<u8>, StoreError> {
        match self {
            Value::Blob(bytes) => Ok(bytes),
            other => Err(StoreError::Io(format!(
                "do sql: {what} column is not a blob ({other:?})"
            ))),
        }
    }
}

fn encode_params(params: &[Value]) -> Vec<u8> {
    let mut out = Vec::new();
    for value in params {
        match value {
            Value::Null => out.push(0),
            Value::Number(n) => {
                out.push(1);
                out.extend_from_slice(&n.to_le_bytes());
            }
            Value::Blob(bytes) => {
                out.push(2);
                out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
                out.extend_from_slice(bytes);
            }
            Value::Text(text) => {
                out.push(3);
                out.extend_from_slice(&(text.len() as u32).to_le_bytes());
                out.extend_from_slice(text.as_bytes());
            }
        }
    }
    out
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], StoreError> {
        let end = self
            .at
            .checked_add(n)
            .filter(|&end| end <= self.bytes.len());
        let Some(end) = end else {
            return Err(StoreError::Io("do sql: truncated result".into()));
        };
        let slice = &self.bytes[self.at..end];
        self.at = end;
        Ok(slice)
    }
    fn u32(&mut self) -> Result<u32, StoreError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn value(&mut self) -> Result<Value, StoreError> {
        match self.take(1)?[0] {
            0 => Ok(Value::Null),
            1 => Ok(Value::Number(f64::from_le_bytes(
                self.take(8)?.try_into().unwrap(),
            ))),
            2 => {
                let len = self.u32()? as usize;
                Ok(Value::Blob(self.take(len)?.to_vec()))
            }
            3 => {
                let len = self.u32()? as usize;
                Ok(Value::Text(
                    String::from_utf8(self.take(len)?.to_vec())
                        .map_err(|_| StoreError::Io("do sql: text is not UTF-8".into()))?,
                ))
            }
            tag => Err(StoreError::Io(format!("do sql: unknown value tag {tag}"))),
        }
    }
}

fn decode_rows(bytes: &[u8]) -> Result<Vec<Vec<Value>>, StoreError> {
    let mut reader = Reader { bytes, at: 0 };
    let rows = reader.u32()? as usize;
    let mut out = Vec::with_capacity(rows);
    for _ in 0..rows {
        let columns = reader.u32()? as usize;
        let mut row = Vec::with_capacity(columns);
        for _ in 0..columns {
            row.push(reader.value()?);
        }
        out.push(row);
    }
    if reader.at != bytes.len() {
        return Err(StoreError::Io(
            "do sql: trailing bytes after the result".into(),
        ));
    }
    Ok(out)
}

fn take_pending(len: usize) -> Vec<u8> {
    let mut buffer = vec![0u8; len];
    let copied = unsafe { host_take(buffer.as_mut_ptr(), len as u32) } as usize;
    buffer.truncate(copied);
    buffer
}

/// Run one statement against the Durable Object's SQLite and return its rows.
pub fn exec(sql: &str, params: &[Value]) -> Result<Vec<Vec<Value>>, StoreError> {
    let encoded = encode_params(params);
    let status = unsafe {
        host_exec(
            sql.as_ptr(),
            sql.len() as u32,
            encoded.as_ptr(),
            encoded.len() as u32,
        )
    };
    if status < 0 {
        // The error text is pending in place of a result; its length is
        // unknown to the guest, so take it in one generous buffer.
        let text = take_pending(64 * 1024);
        return Err(StoreError::Io(format!(
            "do sql: {}",
            String::from_utf8_lossy(&text)
        )));
    }
    decode_rows(&take_pending(status as usize))
}

/// A line on the host's console.
pub fn log(message: &str) {
    unsafe { host_log(message.as_ptr(), message.len() as u32) }
}

/// Bytes from the host's cryptographic randomness (`crypto.getRandomValues`):
/// the source of every commit token the worker mints, on every target
/// (`session.rs`). On `wasm32-unknown-unknown` std has no entropy at all; on
/// WASI it has `random_get`, and the worker's tokens are still the
/// platform's rather than the standard library's.
pub fn random(dst: &mut [u8]) {
    unsafe { host_random(dst.as_mut_ptr(), dst.len() as u32) }
}
