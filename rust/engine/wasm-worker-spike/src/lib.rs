//! The workerd harness for the product crates: `ironhorse_store_do::DoStore`
//! over the Durable Object's SQLite and `thixotrope_ironhorse_core::Worker`
//! over that store, driven through `extern "C-unwind"` exports that never
//! let an unwind cross into JavaScript, beside the engine's store acceptance
//! suite. See README.md.
//!
//! Every export that runs the engine returns a status from under
//! `catch_unwind`: 0 ok, 1 a reported error, 2 a caught unwind (an assertion
//! of the acceptance suite, a store fault, an engine invariant), and from
//! `ih_session_request` also 3, a crank that failed (the message is the
//! core's `fatal` line and the worker is dead), and 4, `close` was requested
//! (no message). The text or bytes that go with a status are pending in a
//! message buffer the host reads with `ih_message_len` and
//! `ih_message_copy`; those two and the buffer allocator pair, `ih_alloc`
//! and `ih_free`, have no path that unwinds. Its imports are the product
//! module's `env` block (`host.rs`).
//!
//! Every pointer an export takes or answers is a `u32` address in the
//! module's linear memory, as in the product module's ABI: on wasm32 an
//! address is a `u32` and `usize` is 32 bits, so the casts are exact.

mod host;
mod session;
mod suite;

use std::cell::RefCell;
use std::ptr::{with_exposed_provenance, with_exposed_provenance_mut};
use std::sync::Once;

use ironhorse_snapshot::machine::store_fault_of;
use thixotrope_ironhorse_core::Step;

thread_local! {
    static MESSAGE: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static LAST_PANIC: RefCell<Option<String>> = const { RefCell::new(None) };
}

static HOOK: Once = Once::new();

const STATUS_FATAL: i32 = 3;
const STATUS_CLOSE: i32 = 4;

fn install_panic_hook() {
    HOOK.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            let text = info.to_string();
            host::log(&format!("panic: {text}"));
            LAST_PANIC.with(|last| *last.borrow_mut() = Some(text));
        }));
    });
}

fn set_message(bytes: Vec<u8>) {
    MESSAGE.with(|message| *message.borrow_mut() = bytes);
}

/// Run a body under `catch_unwind`; its `Ok` is a status of its own choosing
/// with the pending message.
fn guarded_status(body: impl FnOnce() -> Result<(i32, Vec<u8>), String>) -> i32 {
    install_panic_hook();
    LAST_PANIC.with(|last| *last.borrow_mut() = None);
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)) {
        Ok(Ok((status, bytes))) => {
            set_message(bytes);
            status
        }
        Ok(Err(text)) => {
            set_message(text.into_bytes());
            1
        }
        Err(payload) => {
            // A store fault unwinds with `resume_unwind`, which skips the
            // panic hook: its error is the payload itself.
            let text = match store_fault_of(payload) {
                Ok(error) => format!("store fault: {error:?}"),
                Err(_) => LAST_PANIC
                    .with(|last| last.borrow_mut().take())
                    .unwrap_or_else(|| "panic (no message)".to_string()),
            };
            set_message(text.into_bytes());
            2
        }
    }
}

/// Run a body under `catch_unwind`, mapping its outcome to a status and the
/// pending message.
fn guarded(body: impl FnOnce() -> Result<Vec<u8>, String>) -> i32 {
    guarded_status(|| body().map(|bytes| (0, bytes)))
}

/// The buffer at `ptr` of `len` bytes, which the host filled. A null pointer
/// with a length is the host's bug (`ih_alloc` answered null and the host
/// went on), refused rather than read from address zero.
///
/// # Safety
///
/// Unless `len` is zero or `ptr` is null, `ptr..ptr + len` is a buffer that
/// `ih_alloc` answered and the host filled, which nothing writes or frees
/// until the export that received it returns.
unsafe fn slice<'a>(ptr: u32, len: u32) -> Result<&'a [u8], String> {
    if len == 0 {
        Ok(&[])
    } else if ptr == 0 {
        Err("null argument buffer".to_string())
    } else {
        let ptr = with_exposed_provenance::<u8>(ptr as usize);
        Ok(std::slice::from_raw_parts(ptr, len as usize))
    }
}

/// # Safety
///
/// As [`slice`].
unsafe fn text<'a>(ptr: u32, len: u32) -> Result<&'a str, String> {
    std::str::from_utf8(slice(ptr, len)?).map_err(|_| "argument is not UTF-8".to_string())
}

/// Guest memory the host fills: container bytes, source text, names. Null
/// when the allocator refuses (linear memory cannot grow), which the host
/// checks before writing; the exports refuse a null buffer themselves.
#[no_mangle]
pub extern "C-unwind" fn ih_alloc(len: u32) -> u32 {
    match std::alloc::Layout::from_size_align(len.max(1) as usize, 1) {
        Ok(layout) => unsafe { std::alloc::alloc(layout) }.expose_provenance() as u32,
        Err(_) => 0,
    }
}

/// Frees what `ih_alloc(len)` answered, once, with the same `len`.
#[no_mangle]
pub extern "C-unwind" fn ih_free(ptr: u32, len: u32) {
    if ptr == 0 {
        return;
    }
    if let Ok(layout) = std::alloc::Layout::from_size_align(len.max(1) as usize, 1) {
        unsafe { std::alloc::dealloc(with_exposed_provenance_mut(ptr as usize), layout) }
    }
}

#[no_mangle]
pub extern "C-unwind" fn ih_message_len() -> u32 {
    MESSAGE.with(|message| message.borrow().len() as u32)
}

#[no_mangle]
pub extern "C-unwind" fn ih_message_copy(dst: u32, cap: u32) -> u32 {
    if dst == 0 {
        return 0;
    }
    MESSAGE.with(|message| {
        let message = message.borrow();
        let n = message.len().min(cap as usize);
        // The host contract: `dst..dst + cap` is a buffer `ih_alloc`
        // answered, which nothing else references during this call.
        let dst = with_exposed_provenance_mut::<u8>(dst as usize);
        unsafe { std::ptr::copy_nonoverlapping(message.as_ptr(), dst, n) };
        n as u32
    })
}

/// `DoStore::open` on store `id`: create the schema and stamp the database
/// if needed; with `reset`, also empty the store (`reset_for_harness`).
#[no_mangle]
pub extern "C-unwind" fn ih_store_open(id: u32, reset: u32) -> i32 {
    guarded(|| {
        if reset != 0 {
            session::open_clean(id)?;
        } else {
            session::open_store(id)?;
        }
        Ok(Vec::new())
    })
}

/// Run one part of the backend acceptance suite against fresh stores.
#[no_mangle]
pub extern "C-unwind" fn ih_run_suite(name_ptr: u32, name_len: u32) -> i32 {
    guarded(|| {
        suite::run(unsafe { text(name_ptr, name_len)? })?;
        Ok(Vec::new())
    })
}

/// Seed store `id` from container bytes under the runtime profile.
#[no_mangle]
pub extern "C-unwind" fn ih_import(
    id: u32,
    bytes_ptr: u32,
    bytes_len: u32,
    profile_ptr: u32,
    profile_len: u32,
) -> i32 {
    guarded(|| {
        let bytes = unsafe { slice(bytes_ptr, bytes_len)? };
        let profile = unsafe { text(profile_ptr, profile_len)? };
        session::import(id, bytes, profile)?;
        Ok(Vec::new())
    })
}

/// The canonical container of store `id`, as the pending message.
#[no_mangle]
pub extern "C-unwind" fn ih_export(id: u32) -> i32 {
    guarded(|| session::export(id))
}

/// `Worker::begin` on store `id`, emptied first (the harness always wants a
/// clean store; a production open never resets). `limits` is the core's
/// worker-limits JSON.
#[no_mangle]
pub extern "C-unwind" fn ih_session_begin(
    id: u32,
    profile_ptr: u32,
    profile_len: u32,
    limits_ptr: u32,
    limits_len: u32,
) -> i32 {
    guarded(|| {
        let profile = unsafe { text(profile_ptr, profile_len)? };
        let limits = unsafe { text(limits_ptr, limits_len)? };
        session::begin(id, profile, limits)?;
        Ok(Vec::new())
    })
}

/// `Worker::resume` on store `id`, lazily or eagerly.
#[no_mangle]
pub extern "C-unwind" fn ih_session_resume(
    id: u32,
    lazy: u32,
    profile_ptr: u32,
    profile_len: u32,
    limits_ptr: u32,
    limits_len: u32,
) -> i32 {
    guarded(|| {
        let profile = unsafe { text(profile_ptr, profile_len)? };
        let limits = unsafe { text(limits_ptr, limits_len)? };
        session::resume(id, lazy != 0, profile, limits)?;
        Ok(Vec::new())
    })
}

/// `Worker::boot`: one boot source, uncommitted.
#[no_mangle]
pub extern "C-unwind" fn ih_session_boot(
    name_ptr: u32,
    name_len: u32,
    src_ptr: u32,
    src_len: u32,
) -> i32 {
    guarded(|| {
        let name = unsafe { text(name_ptr, name_len)? };
        let source = unsafe { text(src_ptr, src_len)? };
        session::boot(name, source)?;
        Ok(Vec::new())
    })
}

/// `Worker::respond`: one request line, without its terminator. Status 0
/// with the reply line, 3 with the fatal line, or 4 for `close`.
#[no_mangle]
pub extern "C-unwind" fn ih_session_request(line_ptr: u32, line_len: u32) -> i32 {
    guarded_status(|| {
        let line = unsafe { text(line_ptr, line_len)? };
        Ok(match session::request(line)? {
            Step::Continue(reply) => (0, reply.into_bytes()),
            Step::Die { line, .. } => (STATUS_FATAL, line.into_bytes()),
            Step::Close => (STATUS_CLOSE, Vec::new()),
        })
    })
}

/// `Worker::checkpoint`; the message is the new epoch.
#[no_mangle]
pub extern "C-unwind" fn ih_session_checkpoint() -> i32 {
    guarded(|| session::checkpoint().map(|epoch| epoch.to_string().into_bytes()))
}

/// Commit and close the worker; the message is the epoch committed.
#[no_mangle]
pub extern "C-unwind" fn ih_session_close() -> i32 {
    guarded(|| session::close().map(|epoch| epoch.to_string().into_bytes()))
}

#[no_mangle]
pub extern "C-unwind" fn ih_session_stats() -> i32 {
    guarded(|| session::stats().map(String::into_bytes))
}

/// Drop the worker uncommitted; the message is whether there was one.
#[no_mangle]
pub extern "C-unwind" fn ih_session_drop() -> i32 {
    guarded(|| Ok(session::drop_worker().to_string().into_bytes()))
}
