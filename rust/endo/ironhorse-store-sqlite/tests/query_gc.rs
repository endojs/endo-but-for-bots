//! The query-driven GC layer (store seam phase 10) against the SQLite
//! backend: the normalized `edge_pairs` index must agree with the
//! sealed `page_edges` rows it is derived from — same reachability
//! answers as the dense Rust BFS, same reverse edges — and must
//! rebuild itself when a store predates it (or an external hand wiped
//! it): the derived index is never trusted over the sealed source.

use std::cell::RefCell;
use std::rc::Rc;

use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, partial_collect, resume_from_store_lazy,
};
use ironhorse_snapshot::store::{reachable_pages, slot_page_count, HeapStore, MemoryStore};
use ironhorse_snapshot::Signature;
use ironhorse_store_sqlite::SqliteHeapStore;
use ironhorse_vm::{parse_symbols, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("fixture compiles");
    (bytecode, parse_symbols(&symbols))
}

/// Build a store with an interesting page graph: array-held 3-slot
/// objects (side-table references, page-aligned isolation), a dropped
/// chain, and a second incremental checkpoint so `edge_pairs`
/// maintenance runs on both the full and the dirty paths.
fn build_store(store: Rc<RefCell<SqliteHeapStore>>) {
    let cranks = [
        "var arr = []; var g = 0; var t = 0; var i = 0; \
         for (i = 0; i < 2000; i = i + 1) { arr[i] = { v: i, w: i }; } \
         for (i = 0; i < 1000; i = i + 1) { g = { v: i, w: i }; } \
         g = 0; t = 7;",
        "var arr; var g; var t; var i; var v; var w; \
         arr[3] = { v: 1, w: 2 }; t + 1",
    ];
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks.iter().map(|s| compile(s)).collect();
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    assert!(m.run(&compiled[0].0).completed);
    let session = begin_store_session(m, &sig(), &mut *store.borrow_mut())
        .map_err(|(_, e)| e)
        .expect("begin");
    drop(session);
    let mut session = resume_from_store_lazy(store.clone(), &sig()).expect("lazy resume");
    let o = session.machine_mut().run(&compiled[1].0);
    assert!(o.completed, "halt: {:?}", o.halt);
    checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut()).expect("checkpoint");
}

fn assert_parity(store: &SqliteHeapStore) {
    let manifest = store.manifest().unwrap();
    let pages = slot_page_count(manifest.slot_count);
    let dense = store.page_edges().unwrap();

    // Reverse edges: for every target, the pairs answer equals the
    // dense edges inverted.
    for target in 0..pages {
        let expect: Vec<u32> = (0..pages)
            .filter(|&p| dense[p as usize].contains(&target))
            .collect();
        assert_eq!(
            store.pages_referencing(target).unwrap(),
            expect,
            "reverse edges of page {target}"
        );
    }

    // Reachability: the recursive CTE agrees with the dense Rust BFS
    // for several root shapes, including an out-of-range root (both
    // sides treat it as edgeless).
    let all: Vec<u32> = (0..pages).collect();
    for roots in [vec![0u32], vec![0, pages / 2], all, vec![pages + 7]] {
        assert_eq!(
            store.reachable_pages_sql(&roots).unwrap(),
            reachable_pages(store, roots.iter().copied()).unwrap(),
            "reachability parity from roots {roots:?}"
        );
    }
}

#[test]
fn edge_pairs_agree_with_dense_reachability() {
    let dir = std::env::temp_dir().join(format!("ironhorse-query-gc-parity-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let store = Rc::new(RefCell::new(
        SqliteHeapStore::open(dir.join("heap.sqlite")).unwrap(),
    ));
    build_store(store.clone());
    assert_parity(&store.borrow());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn partial_collect_equivalent_across_backends() {
    // The partial collector's decision queries go through the trait:
    // the dense defaults on MemoryStore, the COUNT/CTE overrides
    // here. Machines are deterministic, so the same build must free
    // the same count and leave the same free-list length on both
    // backends — the collector's outcome is a pure function of store
    // content, not of which backend answered the queries.
    let build = "var arr = []; var g = 0; var i = 0; \
                 for (i = 0; i < 3000; i = i + 1) { arr[i] = { v: i, w: i }; } \
                 for (i = 0; i < 1500; i = i + 1) { g = { v: i, w: i }; } \
                 g = 0;";
    let (b, names) = compile(build);

    let run = |store: &mut dyn HeapStore| -> (u32, usize) {
        let mut m = Interp::new();
        m.link_intrinsics(&names);
        assert!(m.run(&b).completed);
        let mut session = begin_store_session(m, &sig(), store)
            .map_err(|(_, e)| e)
            .expect("begin");
        let freed = partial_collect(&mut session, store).expect("partial collect");
        (freed, session.machine().slots.free_list().len())
    };

    let mut mem = MemoryStore::new();
    let (freed_mem, free_len_mem) = run(&mut mem);

    let dir = std::env::temp_dir().join(format!("ironhorse-query-gc-eq-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut sq = SqliteHeapStore::open(dir.join("heap.sqlite")).unwrap();
    let (freed_sq, free_len_sq) = run(&mut sq);
    let _ = std::fs::remove_dir_all(&dir);

    assert!(freed_mem > 1500, "reclaims the dropped chain: {freed_mem}");
    assert_eq!(freed_mem, freed_sq, "freed count backend-independent");
    assert_eq!(free_len_mem, free_len_sq, "free list backend-independent");
}

#[test]
fn edge_pairs_backfill_after_external_wipe() {
    let dir = std::env::temp_dir().join(format!("ironhorse-query-gc-wipe-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("heap.sqlite");
    let store = Rc::new(RefCell::new(SqliteHeapStore::open(&path).unwrap()));
    build_store(store.clone());
    Rc::try_unwrap(store)
        .ok()
        .expect("sole owner")
        .into_inner()
        .close()
        .unwrap();

    // An external hand (or a store written before the derived table
    // existed) leaves edge_pairs empty; the sealed page_edges rows
    // survive.
    {
        let raw = rusqlite::Connection::open(&path).unwrap();
        raw.execute("DELETE FROM edge_pairs", []).unwrap();
        raw.close().unwrap();
    }

    // Reopen: the open-time backfill rebuilds the index from the
    // sealed source, and parity holds again.
    let store = SqliteHeapStore::open(&path).unwrap();
    assert_parity(&store);
    store.close().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}
