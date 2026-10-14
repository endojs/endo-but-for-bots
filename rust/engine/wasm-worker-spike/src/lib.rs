//! The wasm Thixotrope worker spike: the engine's store seam over a Durable
//! Object's SQLite, driven through `extern "C-unwind"` exports that never let
//! an unwind cross into JavaScript. See README.md and
//! `designs/thixotrope-wasm-worker.md`.
//!
//! Every export that runs the engine returns a status from under
//! `catch_unwind`: 0 ok, 1 a reported error, 2 a caught unwind (an assertion
//! of the acceptance suite, a store fault, an engine invariant). The text or
//! bytes that go with it are pending in a message buffer the host reads with
//! `ih_message_len` and `ih_message_copy`; those two and the buffer
//! allocator pair, `ih_alloc` and `ih_free`, have no path that unwinds.

mod host;
mod session;
mod store;

use std::cell::RefCell;
use std::sync::Once;

use ironhorse_snapshot::machine::store_fault_of;
use ironhorse_snapshot::store_suite;

use session::Ceilings;
use store::DoStore;

thread_local! {
    static MESSAGE: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static LAST_PANIC: RefCell<Option<String>> = const { RefCell::new(None) };
}

static HOOK: Once = Once::new();

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

/// Run a body under `catch_unwind`, mapping its outcome to a status and the
/// pending message.
fn guarded(body: impl FnOnce() -> Result<Vec<u8>, String>) -> i32 {
    install_panic_hook();
    LAST_PANIC.with(|last| *last.borrow_mut() = None);
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)) {
        Ok(Ok(bytes)) => {
            set_message(bytes);
            0
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

/// A buffer the host filled. A null pointer with a length is the host's
/// bug (`ih_alloc` answered null and the host went on), refused rather than
/// read from address zero.
unsafe fn slice<'a>(ptr: *const u8, len: u32) -> Result<&'a [u8], String> {
    if len == 0 {
        Ok(&[])
    } else if ptr.is_null() {
        Err("null argument buffer".to_string())
    } else {
        Ok(std::slice::from_raw_parts(ptr, len as usize))
    }
}

unsafe fn text<'a>(ptr: *const u8, len: u32) -> Result<&'a str, String> {
    std::str::from_utf8(slice(ptr, len)?).map_err(|_| "argument is not UTF-8".to_string())
}

/// Guest memory the host fills: container bytes, source text, names. Null
/// when the allocator refuses (linear memory cannot grow), which the host
/// checks before writing; the exports refuse a null buffer themselves.
#[no_mangle]
pub extern "C-unwind" fn ih_alloc(len: u32) -> *mut u8 {
    match std::alloc::Layout::from_size_align(len.max(1) as usize, 1) {
        Ok(layout) => unsafe { std::alloc::alloc(layout) },
        Err(_) => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C-unwind" fn ih_free(ptr: *mut u8, len: u32) {
    if ptr.is_null() {
        return;
    }
    if let Ok(layout) = std::alloc::Layout::from_size_align(len.max(1) as usize, 1) {
        unsafe { std::alloc::dealloc(ptr, layout) }
    }
}

#[no_mangle]
pub extern "C-unwind" fn ih_message_len() -> u32 {
    MESSAGE.with(|message| message.borrow().len() as u32)
}

#[no_mangle]
pub extern "C-unwind" fn ih_message_copy(dst: *mut u8, cap: u32) -> u32 {
    if dst.is_null() {
        return 0;
    }
    MESSAGE.with(|message| {
        let message = message.borrow();
        let n = message.len().min(cap as usize);
        unsafe { std::ptr::copy_nonoverlapping(message.as_ptr(), dst, n) };
        n as u32
    })
}

/// Create the schema and stamp the database; with `reset`, empty store `id`.
#[no_mangle]
pub extern "C-unwind" fn ih_store_open(id: u32, reset: u32) -> i32 {
    guarded(|| {
        DoStore::open(id, reset != 0).map_err(|e| format!("open: {e:?}"))?;
        Ok(Vec::new())
    })
}

/// Run one part of the backend acceptance suite against fresh stores.
#[no_mangle]
pub extern "C-unwind" fn ih_run_suite(name_ptr: *const u8, name_len: u32) -> i32 {
    guarded(|| {
        let name = unsafe { text(name_ptr, name_len)? };
        match name {
            "sparse" => store_suite::sparse_section_acceptance(DoStore::fresh),
            "metamorphic" => store_suite::metamorphic_suite(DoStore::fresh),
            "boundary" => store_suite::boundary_collection_twins(DoStore::fresh),
            "lazy" => store_suite::lazy_working_set_bound(DoStore::fresh),
            "checkpoint" => store_suite::checkpoint_acceptance(&mut DoStore::fresh()),
            "resume" => store_suite::resume_equals_uninterrupted(&mut DoStore::fresh()),
            // Reopen: a new handle on the same id, through the stamp check.
            "commit" => {
                store_suite::commit_contract(DoStore::fresh(), |store| {
                    DoStore::open(store.id(), false).expect("the store reopens")
                });
            }
            "edits" => {
                store_suite::consistent_edits_resume(
                    DoStore::fresh(),
                    |store, kind, index, _old, new| {
                        store
                            .edit_row(kind, index, new)
                            .expect("the row is rewritten");
                        store
                    },
                );
            }
            other => return Err(format!("unknown suite part: {other}")),
        }
        Ok(Vec::new())
    })
}

/// Seed store `id` from container bytes under the runtime profile.
#[no_mangle]
pub extern "C-unwind" fn ih_import(
    id: u32,
    bytes_ptr: *const u8,
    bytes_len: u32,
    profile_ptr: *const u8,
    profile_len: u32,
) -> i32 {
    guarded(|| {
        let bytes = unsafe { slice(bytes_ptr, bytes_len)? };
        let profile = unsafe { text(profile_ptr, profile_len)? };
        let mut store = DoStore::open(id, true).map_err(|e| format!("open: {e:?}"))?;
        session::import(&mut store, bytes, profile)?;
        Ok(Vec::new())
    })
}

/// The canonical container of store `id`, as the pending message.
#[no_mangle]
pub extern "C-unwind" fn ih_export(id: u32) -> i32 {
    guarded(|| {
        let store = DoStore::open(id, false).map_err(|e| format!("open: {e:?}"))?;
        session::export(&store)
    })
}

/// Bind a fresh machine to store `id`, emptied first: the harness always
/// wants a clean store, so the engine's `NotEmpty` guard, which keeps a
/// begin from discarding a heap, is bypassed here. A production begin must
/// not inherit the reset.
#[no_mangle]
pub extern "C-unwind" fn ih_session_begin(
    id: u32,
    profile_ptr: *const u8,
    profile_len: u32,
    slot_ceiling: u32,
    chunk_ceiling: u32,
) -> i32 {
    guarded(|| {
        let profile = unsafe { text(profile_ptr, profile_len)? };
        let store = DoStore::open(id, true).map_err(|e| format!("open: {e:?}"))?;
        session::begin(
            store,
            profile,
            &Ceilings {
                slots: slot_ceiling,
                chunk_bytes: chunk_ceiling as usize,
            },
        )?;
        Ok(Vec::new())
    })
}

/// Wake the machine stored in `id`, lazily or eagerly.
#[no_mangle]
pub extern "C-unwind" fn ih_session_resume(
    id: u32,
    lazy: u32,
    profile_ptr: *const u8,
    profile_len: u32,
    slot_ceiling: u32,
    chunk_ceiling: u32,
) -> i32 {
    guarded(|| {
        let profile = unsafe { text(profile_ptr, profile_len)? };
        let store = DoStore::open(id, false).map_err(|e| format!("open: {e:?}"))?;
        session::resume(
            store,
            lazy != 0,
            profile,
            &Ceilings {
                slots: slot_ceiling,
                chunk_bytes: chunk_ceiling as usize,
            },
        )?;
        Ok(Vec::new())
    })
}

/// One crank: compile, link, run; the completion value is the message. A
/// halt is an error whose text names it, as the worker's `fatal` reply does.
/// The budget is the worker's `u64` of computrons (a wasm `i64`, a JS
/// `BigInt`); zero asks for the default.
#[no_mangle]
pub extern "C-unwind" fn ih_session_eval(src_ptr: *const u8, src_len: u32, budget: u64) -> i32 {
    guarded(|| {
        let source = unsafe { text(src_ptr, src_len)? };
        let budget = if budget == 0 { 10_000_000 } else { budget };
        session::eval_crank(source, budget).map(String::into_bytes)
    })
}

/// Commit the crank's dirty rows; the message is the new epoch.
#[no_mangle]
pub extern "C-unwind" fn ih_session_checkpoint() -> i32 {
    guarded(|| session::checkpoint().map(|epoch| epoch.to_string().into_bytes()))
}

#[no_mangle]
pub extern "C-unwind" fn ih_session_stats() -> i32 {
    guarded(|| session::stats().map(String::into_bytes))
}

#[no_mangle]
pub extern "C-unwind" fn ih_session_drop() -> i32 {
    guarded(|| Ok(session::drop_session().to_string().into_bytes()))
}
