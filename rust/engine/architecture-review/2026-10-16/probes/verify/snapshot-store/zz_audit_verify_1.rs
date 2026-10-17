//! AUDIT VERIFY PROBE (temporary) for snapshot-store map SNS-1/2/3/4/8/12.
use ironhorse_snapshot::machine::{
    begin_shared_store_session, begin_store_session, catch_store_fault, checkpoint_to_store,
    resume_from_store_lazy, StoreSession,
};
use ironhorse_snapshot::store::{
    image_to_batch, CheckpointBatch, CommitToken, CommitVerifier, HeapStore, HeapStoreCommit,
    MemoryStore, StoreError, StoreManifest,
};
use ironhorse_snapshot::{MachineSnapshot, Signature};
use ironhorse_vm::{parse_symbols, Compartment, Interp, Machine, SymbolName};
use std::cell::RefCell;
use std::rc::Rc;
use std::time::Instant;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}
fn compile(src: &str) -> (Vec<u8>, Vec<SymbolName>) {
    let (code, names) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (code, parse_symbols(&names))
}
fn start(setup: &str) -> (StoreSession, MemoryStore) {
    let (code, names) = compile(setup);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    let o = m.run(&code);
    assert!(o.completed, "{:?}", o.halt);
    let mut store = MemoryStore::new();
    let s = begin_store_session(m, &sig(), &mut store).map_err(|(_, e)| e).unwrap();
    (s, store)
}
fn crank(s: &mut StoreSession, src: &str) -> bool {
    let (code, names) = compile(src);
    let code = s.machine_mut().relink_crank(&code, &names).unwrap();
    let o = s.machine_mut().run(&code);
    if !o.completed {
        println!("  crank {src:?} did not complete: {:?}", o.halt);
    }
    o.completed
}
fn ckpt(s: &mut StoreSession, st: &mut MemoryStore) -> (f64, ironhorse_snapshot::store::CommitStats) {
    let t = Instant::now();
    checkpoint_to_store(s, &sig(), st).unwrap();
    (t.elapsed().as_secs_f64(), st.last_commit_stats())
}
fn median3(mut v: Vec<f64>) -> f64 {
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

#[test]
fn a_standalone_vs_shared_vs_guest_compartment() {
    for n in [1_000u32, 100_000] {
        let setup = format!("var big=[]; for(var i=0;i<{n};i++) big[i]=i; var small=[0]; 0");
        // standalone no-op and small[0]++
        let (mut s, mut st) = start(&setup);
        crank(&mut s, "1+1");
        ckpt(&mut s, &mut st);
        let mut noop = vec![];
        for _ in 0..3 {
            crank(&mut s, "1+1");
            noop.push(ckpt(&mut s, &mut st).0);
        }
        let mut inc = vec![];
        let mut inc_bytes = 0;
        for _ in 0..3 {
            crank(&mut s, "small[0] = small[0] + 1; 0");
            let (t, c) = ckpt(&mut s, &mut st);
            inc.push(t);
            inc_bytes = c.small_bytes_written;
        }
        println!(
            "STANDALONE n={n} noop median={:.6}s | small[0]++ median={:.6}s small_bytes={inc_bytes}",
            median3(noop),
            median3(inc)
        );
        // shared Machine path
        let m = Machine::new();
        let a: Compartment = m.new_compartment();
        let ev = |c: &Compartment, src: &str| {
            let (code, symbols) = ironhorse_compile::compile_atoms(src).unwrap();
            assert!(c.evaluate_with_symbols(&code, &symbols).completed);
        };
        ev(&a, &format!("var big=[]; for(var i=0;i<{n};i++) big[i]=i; 0"));
        let mut store = MemoryStore::new();
        let mut session = begin_shared_store_session(m, &sig(), &mut store, 0).ok().unwrap();
        ev(&a, "1+1");
        session.checkpoint(&sig(), &mut store).unwrap();
        let mut times = vec![];
        for _ in 0..3 {
            ev(&a, "1+1");
            let t = Instant::now();
            session.checkpoint(&sig(), &mut store).unwrap();
            times.push(t.elapsed().as_secs_f64());
        }
        let stats = store.last_commit_stats();
        println!(
            "SHARED n={n} noop median={:.6}s sections_written={} small_state_total={}",
            median3(times),
            stats.small_sections_written,
            store.read_small_state().unwrap().len()
        );
    }
}

#[test]
fn b_persist_gate() {
    for n in [1_000u32, 100_000] {
        let (code, names) = compile(&format!(
            "var head=null; for(var i=0;i<{n};i++) head={{f:function(){{return 1}}, next:head}}; 0"
        ));
        let mut m = Interp::new();
        m.link_intrinsics(&names);
        assert!(m.run(&code).completed);
        let mut times = vec![];
        for _ in 0..5 {
            let t = Instant::now();
            assert!(m.stored_unpersistable_row_at_checkpoint().is_none());
            times.push(t.elapsed().as_secs_f64());
        }
        times.sort_by(f64::total_cmp);
        println!("GATE n={n} median={:.6}s", times[2]);
    }
}

/// Delegating store that damages one slot page's bytes on read.
struct Damaged {
    inner: MemoryStore,
    page: u32,
    mode: u8, // 0 = truncate by one record, 1 = io error
}
impl HeapStore for Damaged {
    fn manifest(&self) -> Result<StoreManifest, StoreError> { self.inner.manifest() }
    fn read_small_state(&self) -> Result<Vec<u8>, StoreError> { self.inner.read_small_state() }
    fn read_slot_page(&self, page: u32) -> Result<Vec<u8>, StoreError> {
        let mut b = self.inner.read_slot_page(page)?;
        if page == self.page {
            if self.mode == 1 { return Err(StoreError::Io("injected".into())); }
            b.truncate(b.len() - 20);
        }
        Ok(b)
    }
    fn read_chunk_extent(&self, e: u32) -> Result<Vec<u8>, StoreError> { self.inner.read_chunk_extent(e) }
    fn inventory(&self) -> Result<(Vec<usize>, Vec<usize>), StoreError> { self.inner.inventory() }
    fn read_free_seg(&self, s: u32) -> Result<Vec<u8>, StoreError> { self.inner.read_free_seg(s) }
    fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> { self.inner.page_edges() }
    fn commit_verified(&mut self, v: &mut CommitVerifier<'_>) -> Result<(), StoreError> { self.inner.commit_verified(v) }
}

#[test]
fn c_lazy_fault_on_damaged_row() {
    for mode in [1u8, 0] {
        let (_s, st) = start("var big=[]; for(var i=0;i<2000;i++) big[i]={v:i}; 0");
        let pages = ironhorse_snapshot::store::slot_page_count(st.manifest().unwrap().slot_count);
        let store = Rc::new(RefCell::new(Damaged { inner: st, page: pages - 2, mode }));
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let session = resume_from_store_lazy(store.clone(), &sig())?;
            catch_store_fault(|| {
                for p in 0..pages {
                    session.machine().slots().touch_page(p);
                }
                Ok(())
            })
        }));
        match outcome {
            Ok(Ok(())) => println!("MODE {mode}: no error"),
            Ok(Err(e)) => println!("MODE {mode}: typed StoreError {e:?} classify={:?}", e.classify()),
            Err(p) => {
                let msg = p.downcast_ref::<String>().cloned()
                    .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_default();
                println!("MODE {mode}: UNTYPED PANIC escaped catch_store_fault: {msg}");
            }
        }
    }
}

#[test]
fn d_classification() {
    let (code, names) = compile("var x = 1; 0");
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    assert!(m.run(&code).completed);
    let image = m.snapshot_image(&sig()).unwrap();
    let mut store = MemoryStore::new();
    let first: CheckpointBatch = image_to_batch(&image, 1, CommitToken::ZERO);
    store.commit(&first).unwrap();
    // cadence mismatch
    let mut next = image_to_batch(&image, 2, first.manifest.token);
    next.manifest.collect_every = first.manifest.collect_every + 1;
    let e = store.commit(&next).unwrap_err();
    println!("CADENCE MISMATCH: {e:?} classify={:?}", e.classify());
    // counter regression: stored cranks > batch cranks is impossible here (both 0); bump store? use schema stamp
    let mut next = image_to_batch(&image, 2, first.manifest.token);
    next.manifest.store_schema -= 1;
    let e = store.commit(&next).unwrap_err();
    println!("BATCH SCHEMA STAMP: {e:?} classify={:?}", e.classify());
    // compare: check_batch defect (bad row length) is wrapped
    let mut next = image_to_batch(&image, 2, first.manifest.token);
    if let Some(p) = next.slot_pages.first_mut() { p.1.pop(); }
    let e = store.commit(&next).unwrap_err();
    println!("BATCH ROW LENGTH: {e:?} classify={:?}", e.classify());
    // newer store schema at decode
    let mut bytes = store.manifest().unwrap().encode();
    bytes[10..14].copy_from_slice(&39u32.to_be_bytes());
    let e = StoreManifest::decode(&bytes).unwrap_err();
    println!("MANIFEST SCHEMA 39: {e:?} classify={:?}", e.classify());
}
