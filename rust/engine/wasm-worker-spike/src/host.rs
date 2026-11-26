//! The host imports and what the product crates need from them: the
//! statement executor `DoStore` runs on and the commit-token source the
//! worker draws from.
//!
//! The imports are the product module's (`rust/thixotrope-ironhorse-wasm`,
//! whose crate documentation specifies them): `host_exec` runs one statement
//! with parameters in `ironhorse_store_do::wire`'s encoding and answers the
//! encoded rows' length `n >= 0`, or `-1 - m` with `m` bytes of error text
//! pending instead; `host_take` copies what is pending; `host_log` and
//! `host_random` are a diagnostic line and cryptographic randomness. The
//! harness cannot link the product module's executor, because that crate's
//! `#[no_mangle]` exports would collide with the harness's own, so the few
//! lines that turn the imports into a `SqlExecutor` are repeated here under
//! the same contract: exactly the announced length is taken, and a short
//! copy is a failed statement.

// `StoreError` is the store trait's error type, which the harness does not
// choose.
#![allow(clippy::result_large_err)]

use ironhorse_snapshot::store::{CommitToken, CommitTokenSource, StoreError};
use ironhorse_store_do::{wire, SqlExecutor, Value};

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C-unwind" {
    fn host_exec(sql_ptr: *const u8, sql_len: u32, params_ptr: *const u8, params_len: u32) -> i32;
    fn host_take(dst: *mut u8, cap: u32) -> u32;
    fn host_log(ptr: *const u8, len: u32);
    fn host_random(dst: *mut u8, len: u32);
}

// A native build only type-checks (`cargo check`, `cargo clippy`); the
// imports are satisfied by the Durable Object host alone.
#[cfg(not(target_arch = "wasm32"))]
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

fn take_exactly(len: usize) -> Result<Vec<u8>, StoreError> {
    let mut buffer = vec![0u8; len];
    let copied = unsafe { host_take(buffer.as_mut_ptr(), len as u32) } as usize;
    if copied != len {
        return Err(StoreError::Io(format!(
            "host_take copied {copied} of {len} pending bytes"
        )));
    }
    Ok(buffer)
}

/// `DoStore`'s executor over the Durable Object's `ctx.storage.sql`. A
/// failed statement is `StoreError::Io` with the host's text; a malformed
/// answer is the store's corrupt-row error from `wire::decode_rows`.
#[derive(Debug, Clone, Copy, Default)]
pub struct HostSql;

impl SqlExecutor for HostSql {
    fn exec(&self, sql: &str, params: &[Value]) -> Result<Vec<Vec<Value>>, StoreError> {
        let params = wire::encode_params(params)?;
        let code = unsafe {
            host_exec(
                sql.as_ptr(),
                sql.len() as u32,
                params.as_ptr(),
                params.len() as u32,
            )
        };
        if code >= 0 {
            wire::decode_rows(&take_exactly(code as usize)?)
        } else {
            let text = take_exactly((-1 - i64::from(code)) as usize)?;
            Err(StoreError::Io(String::from_utf8_lossy(&text).into_owned()))
        }
    }
}

/// Commit tokens from the host's randomness, as the product module mints
/// them, rather than from the engine's default source.
#[derive(Debug, Clone, Copy, Default)]
pub struct HostTokens;

impl CommitTokenSource for HostTokens {
    fn next_token(&mut self) -> Result<CommitToken, StoreError> {
        let mut token = [0u8; 16];
        unsafe { host_random(token.as_mut_ptr(), token.len() as u32) };
        Ok(CommitToken(token))
    }
}

/// A line on the host's log.
pub fn log(message: &str) {
    unsafe { host_log(message.as_ptr(), message.len() as u32) }
}
