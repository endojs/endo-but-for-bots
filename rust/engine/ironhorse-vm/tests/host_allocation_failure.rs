//! A host allocator that refuses memory the ceilings admitted halts with
//! `Halt::HostAllocationFailed`, never with the ceiling's
//! `Halt::HeapExhausted` and never by aborting the process
//! (`rust/engine/WASM-MEMORY.md`, deliverable 2; `WASM-BLOCKERS.md` B8).
//!
//! This binary's global allocator stands in for a capped host, such as
//! Wasmtime with `-W max-memory-size` or an isolate whose `memory.grow`
//! fails: while a test thread holds a [`Cap`], an allocation or growth that
//! would take the bytes that thread has live past the cap returns null, as
//! `System` does when memory runs out. The cap counts only the allocations
//! the capped thread makes after arming, so building the machine, the
//! harness, and tests running beside it do not count. A fallible
//! reservation then fails; an infallible one would abort the test binary,
//! which is the failure these tests rule out on the paths they drive.
//!
//! The allocator is this binary's only `unsafe`: [`GlobalAlloc`] cannot be
//! implemented without it. It forwards every call it does not refuse to
//! [`System`] unchanged. The engine's library roots stay
//! `forbid(unsafe_code)`; like `teardown_allocation.rs`, this is test-binary
//! code.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use ironhorse_vm::{Halt, Interp, RunOutcome};

/// Forwards to [`System`], refusing growth past the calling thread's cap.
struct CappedAllocator;

thread_local! {
    /// `Some(cap)` while this thread is capped: how many more bytes it may
    /// have live. Signed, because the thread frees memory it allocated
    /// before the cap was armed. A const-initialized `Cell` needs no lazy
    /// initialization and no destructor, so reading it never allocates.
    static HEADROOM: Cell<Option<isize>> = const { Cell::new(None) };
}

/// Whether this thread may grow its live bytes by `delta`, spending the
/// headroom when it may.
fn admit(delta: isize) -> bool {
    // `try_with`: a thread being torn down may allocate after its locals.
    HEADROOM
        .try_with(|headroom| match headroom.get() {
            Some(left) if delta > left => false,
            Some(left) => {
                headroom.set(Some(left - delta));
                true
            }
            None => true,
        })
        .unwrap_or(true)
}

fn release(bytes: usize) {
    let _ = HEADROOM.try_with(|headroom| {
        if let Some(left) = headroom.get() {
            headroom.set(Some(left.saturating_add(bytes as isize)));
        }
    });
}

// SAFETY: every call that is not refused forwards its arguments to `System`
// unchanged, so it upholds the `GlobalAlloc` contract exactly as `System`
// does. A refusal returns null, which the contract allows for `alloc`,
// `alloc_zeroed` and `realloc` (a refused `realloc` leaves the block
// untouched). The bookkeeping only touches a thread-local `Cell`, which never
// allocates or unwinds.
unsafe impl GlobalAlloc for CappedAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if !admit(layout.size() as isize) {
            return std::ptr::null_mut();
        }
        System.alloc(layout)
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if !admit(layout.size() as isize) {
            return std::ptr::null_mut();
        }
        System.alloc_zeroed(layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if !admit(new_size as isize - layout.size() as isize) {
            return std::ptr::null_mut();
        }
        let grown = System.realloc(ptr, layout, new_size);
        if grown.is_null() {
            release(new_size.saturating_sub(layout.size()));
        }
        grown
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        release(layout.size());
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static ALLOCATOR: CappedAllocator = CappedAllocator;

/// Caps the current thread's live-byte growth until dropped.
struct Cap;

impl Cap {
    fn bytes(cap: usize) -> Cap {
        HEADROOM.set(Some(cap as isize));
        Cap
    }
}

impl Drop for Cap {
    fn drop(&mut self) {
        HEADROOM.set(None);
    }
}

const MIB: usize = 1024 * 1024;

fn machine(source: &str) -> (Interp, Vec<u8>) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
    (vm, code)
}

/// Run `source` on a fresh machine, with this thread's growth capped at
/// `cap` bytes once the machine is built (uncapped for `None`), after
/// `configure` sets its ceilings.
fn run(source: &str, cap: Option<usize>, configure: impl FnOnce(&mut Interp)) -> RunOutcome {
    let (mut vm, code) = machine(source);
    configure(&mut vm);
    let _cap = cap.map(Cap::bytes);
    vm.run(&code)
}

/// `WASM-BLOCKERS.md` B8's program: forty kept strings of a million code
/// units, about 80 MiB of chunks under the default 256 MiB ceiling.
const FORTY_STRINGS: &str =
    "var a = []; for (var i = 0; i < 40; i++) a.push('x'.repeat(1 << 20)); a.length";

#[test]
fn forty_strings_under_a_host_cap_halt_on_the_host_not_the_ceiling() {
    let uncapped = run(FORTY_STRINGS, None, |_| ());
    assert_eq!(uncapped.halt, Halt::Return);
    assert_eq!(uncapped.result, "40");

    let capped = run(FORTY_STRINGS, Some(64 * MIB), |_| ());
    assert_eq!(capped.halt, Halt::HostAllocationFailed);
    assert!(!capped.completed);
    assert!(capped.halt.is_panic(), "never committed");
    assert!(
        capped.halt.is_host_failure(),
        "never recorded as the outcome"
    );
    assert!(capped.computrons < uncapped.computrons);
}

#[test]
fn a_ceiling_below_the_host_cap_still_halts_deterministically() {
    // The ceiling refuses before the host would: the deterministic halt.
    let ceiling = |vm: &mut Interp| vm.set_chunk_ceiling(vm.chunks().byte_size() + 16 * MIB);
    let uncapped = run(FORTY_STRINGS, None, ceiling);
    let capped = run(FORTY_STRINGS, Some(64 * MIB), ceiling);
    assert_eq!(uncapped.halt, Halt::HeapExhausted);
    assert!(!uncapped.halt.is_host_failure());
    assert_eq!(capped.halt, uncapped.halt);
    assert_eq!(capped.computrons, uncapped.computrons);
}

#[test]
fn a_refused_scratch_buffer_halts_on_the_host() {
    // `repeat` admits 40 MB of result against the 256 MiB chunk ceiling,
    // then cannot reserve it.
    let source = "'a'.repeat(20000000).length";
    assert_eq!(run(source, None, |_| ()).result, "20000000");
    assert_eq!(
        run(source, Some(32 * MIB), |_| ()).halt,
        Halt::HostAllocationFailed
    );
}

#[test]
fn a_refused_slot_arena_halts_on_the_host() {
    let source = "var h = null; for (var i = 0; i < 400000; i++) h = { n: h }; 1";
    assert_eq!(run(source, None, |_| ()).halt, Halt::Return);
    assert_eq!(
        run(source, Some(8 * MIB), |_| ()).halt,
        Halt::HostAllocationFailed
    );
}

#[test]
fn refused_map_entries_halt_on_the_host() {
    // Map entries are not admitted against a ceiling; their growth is still
    // fallible.
    let source = "var m = new Map(); for (var i = 0; i < 600000; i++) m.set(i, i); m.size";
    assert_eq!(run(source, None, |_| ()).result, "600000");
    assert_eq!(
        run(source, Some(16 * MIB), |_| ()).halt,
        Halt::HostAllocationFailed
    );
}

#[test]
fn refused_array_items_halt_on_the_host_instead_of_aborting() {
    // Array items live in a `BTreeMap`, whose nodes allocate infallibly: the
    // pre-flight must refuse before a node allocation would abort.
    let source = "var a = []; for (var i = 0; i < 300000; i++) a.push(i); a.length";
    assert_eq!(run(source, None, |_| ()).result, "300000");
    assert_eq!(
        run(source, Some(4 * MIB), |_| ()).halt,
        Halt::HostAllocationFailed
    );
}

#[test]
fn the_process_survives_the_halt() {
    // The halt unwinds cleanly instead of aborting: once memory is available
    // again, a fresh machine restored from the last commit runs, as it would
    // in a recycled wasm instance.
    assert_eq!(
        run(FORTY_STRINGS, Some(64 * MIB), |_| ()).halt,
        Halt::HostAllocationFailed
    );
    assert_eq!(run("1 + 1", None, |_| ()).result, "2");
}
