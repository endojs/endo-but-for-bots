// ONT-26 verifier probe: what StoreError / StoreFailure does a shared-session
// checkpoint report when materializing a pending host compartment fails with
// (a) the deterministic HeapExhausted, (b) the host's HostAllocationFailed?
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use ironhorse_snapshot::machine::begin_shared_store_session;
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::{Halt, Machine};

struct CappedAllocator;
thread_local! {
    static HEADROOM: Cell<Option<isize>> = const { Cell::new(None) };
}
fn admit(delta: isize) -> bool {
    HEADROOM
        .try_with(|h| match h.get() {
            Some(left) if delta > left => false,
            Some(left) => {
                h.set(Some(left - delta));
                true
            }
            None => true,
        })
        .unwrap_or(true)
}
fn release(bytes: usize) {
    let _ = HEADROOM.try_with(|h| {
        if let Some(left) = h.get() {
            h.set(Some(left.saturating_add(bytes as isize)));
        }
    });
}
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

#[test]
fn heap_exhausted_during_pending_materialization() {
    let signature = Signature::new("ont26");
    let m = Machine::new();
    let mut store = MemoryStore::new();
    let mut session = begin_shared_store_session(m, &signature, &mut store, 0)
        .ok()
        .unwrap();
    // Ceiling at current capacity, so create_environment's first slot alloc
    // past the free list halts deterministically.
    session
        .machine()
        .with_persistence(|i| {
            let cap = i.slots().capacity();
            i.set_slot_ceiling(cap).unwrap();
        })
        .unwrap();
    let pending = session.machine().new_compartment();
    let err = session.checkpoint(&signature, &mut store).unwrap_err();
    eprintln!("HEAP: error={err:?} class={:?}", err.classify());
    drop(pending);
}

#[test]
fn host_allocation_failed_during_pending_materialization() {
    let cap: isize = std::env::var("ONT26_CAP")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(32 * 1024);
    let signature = Signature::new("ont26");
    let m = Machine::new();
    let mut store = MemoryStore::new();
    let mut session = begin_shared_store_session(m, &signature, &mut store, 0)
        .ok()
        .unwrap();
    let pending = session.machine().new_compartment();
    HEADROOM.set(Some(cap));
    let err = session.checkpoint(&signature, &mut store);
    HEADROOM.set(None);
    match err {
        Err(err) => {
            eprintln!("HOST cap={cap}: error={err:?} class={:?}", err.classify());
            eprintln!(
                "Halt::HostAllocationFailed.is_host_failure()={}",
                Halt::HostAllocationFailed.is_host_failure()
            );
        }
        Ok(epoch) => eprintln!("HOST cap={cap}: checkpoint succeeded epoch={epoch}"),
    }
    drop(pending);
}

#[test]
fn measure() {
    let signature = Signature::new("ont26");
    let m = Machine::new();
    let mut store = MemoryStore::new();
    let mut session = begin_shared_store_session(m, &signature, &mut store, 0)
        .ok()
        .unwrap();
    let info = |s: &ironhorse_snapshot::machine::SharedStoreSession| {
        s.machine()
            .with_persistence(|i| {
                (
                    i.slots().capacity(),
                    i.slots().live_count(),
                    i.slots().resident_byte_size(),
                )
            })
            .unwrap()
    };
    eprintln!("before: {:?}", info(&session));
    let pending = session.machine().new_compartment();
    eprintln!("after materialize: {:?}", info(&session));
    session.checkpoint(&signature, &mut store).unwrap();
    drop(pending);
}

/// Fill the slot arena so that materializing the pending compartment's
/// environment must grow the record vector, then cap the host allocator below
/// that growth: create_environment's fallible `try_reserve` fails and the
/// engine reports Halt::HostAllocationFailed through prepare_persistence.
#[test]
fn host_failure_via_slot_vector_growth() {
    let headroom: isize = std::env::var("ONT26_HEADROOM")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(150_000);
    let signature = Signature::new("ont26");
    let m = Machine::new();
    let mut store = MemoryStore::new();
    let mut session = begin_shared_store_session(m, &signature, &mut store, 0)
        .ok()
        .unwrap();
    let info = |s: &ironhorse_snapshot::machine::SharedStoreSession| {
        s.machine()
            .with_persistence(|i| (i.slots().capacity(), i.slots().live_count()))
            .unwrap()
    };
    let start = session.machine().start_compartment();
    let run = |src: &str| {
        let (code, symbols) = ironhorse_compile::compile_atoms(src).unwrap();
        let o = start.evaluate_with_symbols(&code, &symbols);
        assert!(o.completed, "{src}: {:?}", o.halt);
    };
    run("var keep = []; 0");
    const TARGET: u32 = 8192;
    const K: u32 = 76;
    loop {
        let (len, live) = info(&session);
        if len > TARGET - K + 8 {
            assert!(len <= TARGET, "overshot: {len}");
            eprintln!("filled: len={len} live={live}");
            break;
        }
        if len + 200 < TARGET - K {
            run("for (var i = 0; i < 50; i++) keep.push({}); 0");
        } else {
            run("keep.push({}); 0");
        }
    }
    let pending = session.machine().new_compartment();
    HEADROOM.set(Some(headroom));
    let result = session.checkpoint(&signature, &mut store);
    HEADROOM.set(None);
    match result {
        Err(err) => eprintln!(
            "VECTOR headroom={headroom}: error={err:?} class={:?}; Halt::HostAllocationFailed.is_host_failure()={}",
            err.classify(),
            Halt::HostAllocationFailed.is_host_failure()
        ),
        Ok(epoch) => eprintln!("VECTOR headroom={headroom}: checkpoint succeeded epoch={epoch}"),
    }
    // Control: the same checkpoint, retried uncapped, succeeds.
    eprintln!("RETRY uncapped: {:?}", session.checkpoint(&signature, &mut store));
    eprintln!("after: {:?}", info(&session));
    drop(pending);
}
