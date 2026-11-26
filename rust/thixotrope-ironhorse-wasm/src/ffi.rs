//! The raw import block and the raw exports: the only code in the crate that
//! is `unsafe` or touches a pointer. Each export turns its pointers into
//! slices and hands them to the safe [`Instance`]; each import is wrapped in
//! [`HostImports`].
//!
//! Every pointer here is an address in this module's linear memory. On
//! `wasm32` an address is a `u32` and `usize` is 32 bits, so the casts
//! between them below are exact.

use std::alloc::Layout;
use std::ptr::{with_exposed_provenance, with_exposed_provenance_mut};
use std::sync::Once;

use crate::host::{HostExecutor, HostTokens, Imports};
use crate::instance::{Arg, Instance, ABI_VERSION, STATUS_UNWIND};

#[cfg(not(target_pointer_width = "32"))]
compile_error!("the export ABI carries addresses as u32: build for wasm32");

#[link(wasm_import_module = "env")]
extern "C-unwind" {
    fn host_exec(sql_ptr: *const u8, sql_len: u32, params_ptr: *const u8, params_len: u32) -> i32;
    fn host_take(dst: *mut u8, cap: u32) -> u32;
    fn host_log(ptr: *const u8, len: u32);
    fn host_random(dst: *mut u8, len: u32) -> i32;
}

/// The `env` imports. The host contract (crate documentation) is what makes
/// each call sound: an import reads or writes only the buffer it is given,
/// within its length, and never calls back into the module.
#[derive(Debug, Clone, Copy, Default)]
pub struct HostImports;

impl Imports for HostImports {
    fn exec(&self, sql: &[u8], params: &[u8]) -> i32 {
        // SAFETY: both slices are live for the call and their lengths are
        // exact (no slice in wasm32 exceeds u32); the host only reads them.
        unsafe {
            host_exec(
                sql.as_ptr(),
                sql.len() as u32,
                params.as_ptr(),
                params.len() as u32,
            )
        }
    }

    fn take(&self, len: usize) -> Vec<u8> {
        let mut buffer = vec![0u8; len];
        // SAFETY: the buffer is initialised, writable and `len` bytes long;
        // the host writes at most `cap` bytes into it.
        let copied = unsafe { host_take(buffer.as_mut_ptr(), len as u32) };
        buffer.truncate(copied as usize);
        buffer
    }

    fn random(&self, dst: &mut [u8]) -> bool {
        // SAFETY: `dst` is writable for exactly its length, which the host
        // fills and does not exceed.
        unsafe { host_random(dst.as_mut_ptr(), dst.len() as u32) == 0 }
    }
}

/// A diagnostic line on the host's log.
fn log(message: &str) {
    // SAFETY: the slice is live for the call; the host only reads it.
    unsafe { host_log(message.as_ptr(), message.len() as u32) }
}

thread_local! {
    // The module is single-threaded: it is built without the threads
    // feature, so its memory is not shared and no two exports run at once.
    static INSTANCE: Instance<HostExecutor<HostImports>> = const { Instance::new() };
}

static HOOK: Once = Once::new();

/// Route panic messages to the host's log instead of std's stderr (which,
/// on WASI, reads the environment first).
fn install_panic_hook() {
    HOOK.call_once(|| {
        std::panic::set_hook(Box::new(|info| log(&format!("panic: {info}"))));
    });
}

fn with_instance(f: impl FnOnce(&Instance<HostExecutor<HostImports>>) -> i32) -> i32 {
    install_panic_hook();
    INSTANCE.try_with(f).unwrap_or(STATUS_UNWIND)
}

/// The buffer at `ptr` of `len` bytes.
///
/// # Safety
///
/// Unless `len` is zero or `ptr` is null, `ptr..ptr + len` is a buffer that
/// `ih_alloc` answered and the host filled, which nothing writes or frees
/// until the export that received it returns.
unsafe fn argument<'a>(ptr: u32, len: u32) -> Arg<'a> {
    if len == 0 {
        return Ok(&[]);
    }
    if ptr == 0 {
        return Err("a null buffer with a length");
    }
    let ptr = with_exposed_provenance::<u8>(ptr as usize);
    // SAFETY: the caller's contract: one live allocation of `len` bytes,
    // unaliased by any reference for the duration of the export.
    Ok(unsafe { std::slice::from_raw_parts(ptr, len as usize) })
}

#[no_mangle]
pub extern "C-unwind" fn ih_abi_version() -> u32 {
    ABI_VERSION
}

/// A guest buffer of `len` bytes for the host to write into; 0 when linear
/// memory cannot grow.
#[no_mangle]
pub extern "C-unwind" fn ih_alloc(len: u32) -> u32 {
    let Ok(layout) = Layout::from_size_align(len.max(1) as usize, 1) else {
        return 0;
    };
    // SAFETY: the layout's size is non-zero. The allocator answers null
    // rather than unwinding when memory cannot grow.
    let ptr = unsafe { std::alloc::alloc(layout) };
    ptr.expose_provenance() as u32
}

#[no_mangle]
pub extern "C-unwind" fn ih_free(ptr: u32, len: u32) {
    if ptr == 0 {
        return;
    }
    let Ok(layout) = Layout::from_size_align(len.max(1) as usize, 1) else {
        return;
    };
    // SAFETY: the host contract: `ptr` is what `ih_alloc(len)` answered,
    // freed once, with the same `len`.
    unsafe { std::alloc::dealloc(with_exposed_provenance_mut(ptr as usize), layout) }
}

#[no_mangle]
pub extern "C-unwind" fn ih_message_len() -> u32 {
    INSTANCE.try_with(Instance::message_len).unwrap_or(0) as u32
}

#[no_mangle]
pub extern "C-unwind" fn ih_message_copy(dst: u32, cap: u32) -> u32 {
    if dst == 0 || cap == 0 {
        return 0;
    }
    let ptr = with_exposed_provenance_mut::<u8>(dst as usize);
    // SAFETY: the host contract: `dst..dst + cap` is a buffer `ih_alloc`
    // answered, which nothing else references during this call.
    let out = unsafe { std::slice::from_raw_parts_mut(ptr, cap as usize) };
    INSTANCE
        .try_with(|instance| instance.copy_message(out))
        .unwrap_or(0) as u32
}

#[no_mangle]
pub extern "C-unwind" fn ih_open(
    fresh: u32,
    lazy: u32,
    profile_ptr: u32,
    profile_len: u32,
    limits_ptr: u32,
    limits_len: u32,
) -> i32 {
    with_instance(|instance| {
        // SAFETY: the host contract for an export's argument buffers.
        let (profile, limits) = unsafe {
            (
                argument(profile_ptr, profile_len),
                argument(limits_ptr, limits_len),
            )
        };
        instance.open(
            HostExecutor(HostImports),
            Box::new(HostTokens(HostImports)),
            fresh,
            lazy,
            profile,
            limits,
        )
    })
}

#[no_mangle]
pub extern "C-unwind" fn ih_boot(name_ptr: u32, name_len: u32, src_ptr: u32, src_len: u32) -> i32 {
    with_instance(|instance| {
        // SAFETY: the host contract for an export's argument buffers.
        let (name, source) = unsafe { (argument(name_ptr, name_len), argument(src_ptr, src_len)) };
        instance.boot(name, source)
    })
}

#[no_mangle]
pub extern "C-unwind" fn ih_ready() -> i32 {
    with_instance(Instance::ready)
}

#[no_mangle]
pub extern "C-unwind" fn ih_request(line_ptr: u32, line_len: u32) -> i32 {
    with_instance(|instance| {
        // SAFETY: the host contract for an export's argument buffers.
        let line = unsafe { argument(line_ptr, line_len) };
        instance.request(line)
    })
}

#[no_mangle]
pub extern "C-unwind" fn ih_close() -> i32 {
    with_instance(Instance::close)
}
