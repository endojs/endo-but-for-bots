//! The store's statement executor and the commit-token source over the host
//! imports, written against [`Imports`] so that their logic is the same in
//! the module and under native tests.

// `StoreError` is the store trait's error type, which this crate does not
// choose.
#![allow(clippy::result_large_err)]

use ironhorse_snapshot::store::{CommitToken, CommitTokenSource, StoreError};
use ironhorse_store_do::{wire, SqlExecutor, Value};

/// The `env` imports as safe calls. The module's implementation is the only
/// code in the crate that reaches the raw imports.
pub trait Imports {
    /// `host_exec`: run one statement with its encoded parameters. Answers
    /// the encoded result's length, or `-1 - n` when the statement failed
    /// and `n` bytes of its error text are pending instead.
    fn exec(&self, sql: &[u8], params: &[u8]) -> i32;
    /// `host_take`: copy up to `len` pending bytes into a fresh buffer,
    /// which is as long as what was copied.
    fn take(&self, len: usize) -> Vec<u8>;
    /// `host_random`: fill `dst` from the host's cryptographic randomness;
    /// false if the host could not.
    fn random(&self, dst: &mut [u8]) -> bool;
}

/// The length an answer from `host_exec` announces, or the length of the
/// pending error text.
fn announced(code: i32) -> Result<usize, usize> {
    let wide = i64::from(code);
    let (len, ok) = if wide >= 0 {
        (wide, true)
    } else {
        (-1 - wide, false)
    };
    // Both are below 2^31, which every target's usize holds.
    let len = usize::try_from(len).unwrap_or(usize::MAX);
    if ok {
        Ok(len)
    } else {
        Err(len)
    }
}

fn take_exactly(imports: &impl Imports, len: usize) -> Result<Vec<u8>, StoreError> {
    let bytes = imports.take(len);
    if bytes.len() != len {
        return Err(StoreError::Io(format!(
            "host_take copied {} of {len} pending bytes",
            bytes.len()
        )));
    }
    Ok(bytes)
}

/// [`ironhorse_store_do::DoStore`]'s executor over the imports. A failed
/// statement is [`StoreError::Io`] carrying the host's text as it stands;
/// a malformed answer is the store's corrupt-row error from
/// [`wire::decode_rows`].
#[derive(Debug, Clone, Copy, Default)]
pub struct HostExecutor<I>(pub I);

impl<I: Imports> SqlExecutor for HostExecutor<I> {
    fn exec(&self, sql: &str, params: &[Value]) -> Result<Vec<Vec<Value>>, StoreError> {
        let params = wire::encode_params(params)?;
        match announced(self.0.exec(sql.as_bytes(), &params)) {
            Ok(len) => wire::decode_rows(&take_exactly(&self.0, len)?),
            Err(len) => {
                let text = take_exactly(&self.0, len)?;
                Err(StoreError::Io(String::from_utf8_lossy(&text).into_owned()))
            }
        }
    }
}

/// Commit tokens from the host's randomness, in place of the engine's
/// default source, which would draw from the WASI clock and std's keys. A
/// failed fill is [`StoreError::TokenSource`]: the commit that needed the
/// token fails, as an ordinary error, before it writes anything.
#[derive(Debug, Clone, Copy, Default)]
pub struct HostTokens<I>(pub I);

impl<I: Imports> CommitTokenSource for HostTokens<I> {
    fn next_token(&mut self) -> Result<CommitToken, StoreError> {
        let mut token = [0u8; 16];
        if !self.0.random(&mut token) {
            return Err(StoreError::TokenSource("the host's randomness failed"));
        }
        Ok(CommitToken(token))
    }
}
