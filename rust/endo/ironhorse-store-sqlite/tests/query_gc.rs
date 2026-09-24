//! The query-driven GC layer (store seam phase 10) against the SQLite
//! backend: the normalized `edge_pairs` index must agree with the
//! sealed `page_edges` rows it is derived from — same reachability
//! answers as the dense Rust BFS, same reverse edges — and must
//! rebuild itself at open when the store does not attest it for the
//! committed epoch (a store from before the table or its marker, or
//! one last committed by a build that does not keep the marker). An
//! index the store does attest is trusted as stored (issue #1330).

use std::cell::RefCell;
use std::rc::Rc;

use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, partial_collect, resume_from_store_lazy,
};
use ironhorse_snapshot::store::{reachable_pages, slot_page_count, HeapStore, MemoryStore};
use ironhorse_snapshot::{FileStore, Signature};
use ironhorse_store_sqlite::SqliteHeapStore;
use ironhorse_vm::{parse_symbols, Interp};
use rusqlite::OptionalExtension;

mod common;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("fixture compiles");
    (bytecode, parse_symbols(&symbols))
}

/// Build a store with an interesting page graph: array-held 3-slot
/// objects (crank 1's loop index is a VARIABLE, so the writes go
/// through the dynamic element path and populate the items map —
/// real side-table references, page-aligned isolation), a dropped
/// chain, and a second incremental checkpoint so `edge_pairs`
/// maintenance runs on both the full and the dirty paths. Crank 2's
/// `arr[3] = {...}` uses a LITERAL index, which this engine binds as
/// an id-keyed ordinary property — literal-index access does not
/// consult the items map (wave-3 finding) — so the second checkpoint
/// exercises dirty pages and edge maintenance through the property
/// graph, not the array-element path.
fn build_store(store: Rc<RefCell<SqliteHeapStore>>) {
    let cranks = [
        "var arr = []; var g = 0; var t = 0; var i = 0; \
         for (i = 0; i < 2000; i = i + 1) { arr[i] = { v: i, w: i }; } \
         for (i = 0; i < 1000; i = i + 1) { g = { v: i, w: i }; } \
         g = 0; t = 7;",
        "var arr; var g; var t; var i; var v; var w; \
         arr[3] = { v: 1, w: 2 }; t + 1",
    ];
    let compiled: Vec<(Vec<u8>, Vec<ironhorse_vm::SymbolName>)> =
        cranks.iter().map(|s| compile(s)).collect();
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    assert!(m.run(&compiled[0].0).completed);
    let session = begin_store_session(m, &sig(), &mut *store.borrow_mut())
        .map_err(|(_, e)| e)
        .expect("begin");
    drop(session);
    let mut session = resume_from_store_lazy(store.clone(), &sig()).expect("lazy resume");
    // Crank 2 goes through `relink_crank`, the production boundary: its
    // symbol atom is not positionally aligned with crank 1's (crank 1
    // interns `length`, crank 2 does not), so an unrelinked run bound
    // `arr` to `undefined` — and `arr[3] = …` was a silent no-op that only
    // looked like the property-graph write this suite describes. That
    // access now throws, as it should, so the graph is built for real.
    let (b2, n2) = &compiled[1];
    let b2 = session.machine_mut().relink_crank(b2, n2).expect("relink");
    let o = session.machine_mut().run(&b2);
    assert!(o.completed, "halt: {:?}", o.halt);
    // Pin the binding, not just completion: a misbound crank 2 would still
    // complete while silently changing the graph this suite builds.
    assert_eq!(o.result, "8", "crank-2 symbol binding pinned");
    checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut()).expect("checkpoint");
    ironhorse_snapshot::store::validate_store_content(&*store.borrow(), &sig())
        .expect("the store validates");
}

/// Build the fixture store at `path`, close it fully, and return its
/// committed epoch.
fn build_closed_store(path: &std::path::Path) -> u64 {
    let store = Rc::new(RefCell::new(SqliteHeapStore::open(path).unwrap()));
    build_store(store.clone());
    let epoch = store.borrow().manifest().unwrap().epoch;
    Rc::try_unwrap(store)
        .ok()
        .expect("sole owner")
        .into_inner()
        .close()
        .unwrap();
    epoch
}

/// The store's `edge_pairs_epoch` marker, read through a raw
/// connection: the big-endian epoch its edge index is attested for.
fn stored_marker(path: &std::path::Path) -> Option<Vec<u8>> {
    let raw = rusqlite::Connection::open(path).unwrap();
    let marker = raw
        .query_row(
            "SELECT value FROM meta WHERE key = 'edge_pairs_epoch'",
            [],
            |r| r.get(0),
        )
        .optional()
        .unwrap();
    raw.close().unwrap();
    marker
}

fn assert_parity(store: &SqliteHeapStore) {
    let manifest = store.manifest().unwrap();
    let pages = slot_page_count(manifest.slot_count);
    let dense = store.page_edges().unwrap();

    // Reverse edges: for every target, the pairs answer equals the
    // dense edges inverted. Because this sweeps EVERY target, it is
    // also the content-mirror check: a stale, missing, or moved pair
    // (not just a miscounted one) fails here.
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
    // for several root shapes, including the empty set and an
    // out-of-range root (both sides treat the latter as edgeless).
    let all: Vec<u32> = (0..pages).collect();
    for roots in [vec![], vec![0u32], vec![0, pages / 2], all, vec![pages + 7]] {
        assert_eq!(
            store.reachable_pages_sql(&roots).unwrap(),
            reachable_pages(store, roots.iter().copied()).unwrap(),
            "reachability parity from roots {roots:?}"
        );
    }
}

#[test]
fn edge_pairs_agree_with_dense_reachability() {
    let dir = common::TempDir::new(&format!("ironhorse-query-gc-parity-{}", std::process::id()));
    let store = Rc::new(RefCell::new(
        SqliteHeapStore::open(dir.join("heap.sqlite")).unwrap(),
    ));
    build_store(store.clone());
    assert_parity(&store.borrow());
}

#[test]
fn partial_collect_equivalent_across_backends() {
    // The partial collector's decision queries go through the trait:
    // the dense defaults on MemoryStore AND FileStore, the COUNT/CTE
    // overrides here. FileStore is the durable non-DB backend the
    // review found had NO partial_collect coverage anywhere — its
    // edge-section decode and post-commit reload feed the same
    // decision queries, so it joins the equivalence. Machines are
    // deterministic, so the same build must free the same count and
    // leave the same free-list length on all three backends — the
    // collector's outcome is a pure function of store content, not of
    // which backend answered the queries.
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
        (freed, session.machine().slots().free_list().len())
    };

    let mut mem = MemoryStore::new();
    let (freed_mem, free_len_mem) = run(&mut mem);

    let dir = common::TempDir::new(&format!("ironhorse-query-gc-eq-{}", std::process::id()));
    let mut file = FileStore::open(dir.join("heap.ihstore")).unwrap();
    let (freed_file, free_len_file) = run(&mut file);
    let mut sq = SqliteHeapStore::open(dir.join("heap.sqlite")).unwrap();
    let (freed_sq, free_len_sq) = run(&mut sq);

    assert!(freed_mem > 1500, "reclaims the dropped chain: {freed_mem}");
    assert_eq!(freed_mem, freed_file, "freed count: memory vs file");
    assert_eq!(freed_mem, freed_sq, "freed count: memory vs sqlite");
    assert_eq!(free_len_mem, free_len_file, "free list: memory vs file");
    assert_eq!(free_len_mem, free_len_sq, "free list: memory vs sqlite");
}

#[test]
fn edge_pairs_rebuilt_after_count_preserving_desync() {
    // An index that MOVED one pair — count unchanged, the edit a
    // cardinality-only staleness gate trusts forever (the wave-2
    // review's top finding) — is rebuilt at open whenever the
    // store does not attest it for the committed epoch: every store
    // written before the marker existed ("absent"), and one whose last
    // commit came from a build that does not keep the marker
    // ("older-epoch"). Staleness is the marker's call, never a count's,
    // so parity must hold again after reopen — and the marker must be
    // exactly as stale as before: only a commit attests the index, so
    // open never writes the marker on a store its caller may still
    // refuse.
    for case in ["absent", "older-epoch"] {
        let dir = common::TempDir::new(&format!(
            "ironhorse-query-gc-move-{case}-{}",
            std::process::id()
        ));
        let path = dir.join("heap.sqlite");
        let epoch = build_closed_store(&path);
        assert_eq!(
            stored_marker(&path),
            Some(epoch.to_be_bytes().to_vec()),
            "[{case}] commits attest the index for the committed epoch"
        );

        {
            let raw = rusqlite::Connection::open(&path).unwrap();
            let (target, page): (i64, i64) = raw
                .query_row("SELECT target, page FROM edge_pairs LIMIT 1", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .expect("fixture has at least one edge pair");
            // Move it to a page value no legitimate pair occupies (pages
            // are < the geometry), so the primary key cannot collide and
            // the edit is purely count-preserving.
            raw.execute(
                "UPDATE edge_pairs SET page = 1000000 WHERE target = ?1 AND page = ?2",
                rusqlite::params![target, page],
            )
            .unwrap();
            let changed = match case {
                "absent" => raw.execute("DELETE FROM meta WHERE key = 'edge_pairs_epoch'", []),
                _ => raw.execute(
                    "UPDATE meta SET value = ?1 WHERE key = 'edge_pairs_epoch'",
                    rusqlite::params![&(epoch - 1).to_be_bytes()[..]],
                ),
            }
            .unwrap();
            assert_eq!(changed, 1, "[{case}] the marker edit hit the marker row");
            raw.close().unwrap();
        }
        let stale = stored_marker(&path);

        let store = SqliteHeapStore::open(&path).unwrap();
        assert_parity(&store);
        store.close().unwrap();
        assert_eq!(
            stored_marker(&path),
            stale,
            "[{case}] open rebuilt the index without attesting it"
        );
    }
}

#[test]
fn open_trusts_an_attested_edge_index() {
    // Issue #1330: a store whose marker names its committed epoch opens
    // WITHOUT rebuilding the derived index — the attested index is
    // trusted, and open writes nothing. The proof is a canary pair no
    // summary derives (its target and page both lie beyond the
    // geometry): any rebuild deletes it, a trusting open leaves it in
    // place. The empty WAL shows open wrote no page; the previous
    // build's rebuild, which rewrote identical rows, still left frames
    // there. This arm bites if anyone reintroduces a rebuild at every
    // open.
    const CANARY_TARGET: u32 = 7_654_321;
    const CANARY_PAGE: u32 = 1_234_567;
    let dir = common::TempDir::new(&format!("ironhorse-query-gc-trust-{}", std::process::id()));
    let path = dir.join("heap.sqlite");
    build_closed_store(&path);
    {
        let raw = rusqlite::Connection::open(&path).unwrap();
        raw.execute(
            "INSERT INTO edge_pairs (target, page) VALUES (?1, ?2)",
            rusqlite::params![CANARY_TARGET, CANARY_PAGE],
        )
        .unwrap();
        raw.close().unwrap();
    }

    let store = SqliteHeapStore::open(&path).unwrap();
    let wal = path.with_extension("sqlite-wal");
    assert_eq!(
        std::fs::metadata(&wal).map_or(0, |m| m.len()),
        0,
        "open appended nothing to the WAL"
    );
    assert_eq!(
        store.pages_referencing(CANARY_TARGET).unwrap(),
        vec![CANARY_PAGE],
        "open left the attested index exactly as stored"
    );
    store.close().unwrap();
}

#[test]
fn stale_store_rebuilds_before_its_first_commit_attests_the_index() {
    // The upgrade path of every store written before the marker: open
    // finds no marker and rebuilds, and the first checkpoint after it
    // attests the index. That checkpoint is incremental — a resumed
    // session writes only the pages its crank dirtied — so the index it
    // attests is right only if open really rebuilt. The at-rest wipe
    // below makes a skipped rebuild visible: the pairs of every page the
    // crank does not touch would stay missing, now attested, and the
    // trusting reopen's parity check would fail.
    let dir = common::TempDir::new(&format!(
        "ironhorse-query-gc-upgrade-{}",
        std::process::id()
    ));
    let path = dir.join("heap.sqlite");
    let epoch = build_closed_store(&path);
    {
        let raw = rusqlite::Connection::open(&path).unwrap();
        raw.execute_batch(
            "DELETE FROM edge_pairs;
             DELETE FROM meta WHERE key = 'edge_pairs_epoch';",
        )
        .unwrap();
        raw.close().unwrap();
    }

    let store = Rc::new(RefCell::new(SqliteHeapStore::open(&path).unwrap()));
    let mut session = resume_from_store_lazy(store.clone(), &sig()).expect("lazy resume");
    // `t` is 7 in the built store, so "9" pins the crank's binding too.
    let (bytecode, names) = compile("var arr; var g; var t; var i; var v; var w; t = t + 2; t");
    let bytecode = session
        .machine_mut()
        .relink_crank(&bytecode, &names)
        .expect("relink");
    let o = session.machine_mut().run(&bytecode);
    assert!(o.completed, "halt: {:?}", o.halt);
    assert_eq!(o.result, "9");
    let committed =
        checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut()).expect("checkpoint");
    ironhorse_snapshot::store::validate_store_content(&*store.borrow(), &sig())
        .expect("the store validates");
    assert_eq!(committed, epoch + 1);
    drop(session);
    Rc::try_unwrap(store)
        .ok()
        .expect("sole owner")
        .into_inner()
        .close()
        .unwrap();
    assert_eq!(
        stored_marker(&path),
        Some(committed.to_be_bytes().to_vec()),
        "the first commit attests the rebuilt index"
    );

    let store = SqliteHeapStore::open(&path).unwrap();
    assert_parity(&store);
    store.close().unwrap();
}

#[test]
fn summary_page_count_refuses_gapped_page_edges() {
    // The SummaryCount gate must stay STRUCTURAL on this backend
    // (review finding): a gapped page_edges table with a spurious
    // beyond-geometry row has the right COUNT(*) while an interior
    // page is missing — the dense default fails closed on that shape
    // (MissingRow), so the COUNT override must refuse it too.
    let dir = common::TempDir::new(&format!("ironhorse-query-gc-gap-{}", std::process::id()));
    let path = dir.join("heap.sqlite");
    let store = Rc::new(RefCell::new(SqliteHeapStore::open(&path).unwrap()));
    build_store(store.clone());
    let pages = {
        let s = store.borrow();
        let m = s.manifest().unwrap();
        slot_page_count(m.slot_count)
    };
    assert_eq!(
        store.borrow().summary_page_count().unwrap(),
        pages,
        "healthy store reports its geometry"
    );
    Rc::try_unwrap(store)
        .ok()
        .expect("sole owner")
        .into_inner()
        .close()
        .unwrap();

    {
        let raw = rusqlite::Connection::open(&path).unwrap();
        raw.execute("DELETE FROM page_edges WHERE page = 1", [])
            .unwrap();
        raw.execute(
            "INSERT INTO page_edges (page, targets) VALUES (?1, x'00000000')",
            rusqlite::params![(pages + 5) as i64],
        )
        .unwrap();
        raw.close().unwrap();
    }

    let store = SqliteHeapStore::open(&path).unwrap();
    let err = store.summary_page_count().unwrap_err();
    assert!(
        format!("{err:?}").contains("not contiguous"),
        "gap + phantom row fails closed, got {err:?}"
    );
    store.close().unwrap();
}

#[test]
fn edge_pairs_backfill_for_a_store_that_predates_the_table() {
    let dir = common::TempDir::new(&format!("ironhorse-query-gc-legacy-{}", std::process::id()));
    let path = dir.join("heap.sqlite");
    build_closed_store(&path);

    // A store written before the derived index existed has neither the
    // table nor its marker; only the sealed page_edges rows carry the
    // graph. (Dropping the table drops its page index with it.)
    {
        let raw = rusqlite::Connection::open(&path).unwrap();
        raw.execute_batch(
            "DROP TABLE edge_pairs;
             DELETE FROM meta WHERE key = 'edge_pairs_epoch';",
        )
        .unwrap();
        raw.close().unwrap();
    }

    // Reopen: open recreates the table and backfills it from the sealed
    // source, and parity holds. Attesting it waits for the first commit.
    let store = SqliteHeapStore::open(&path).unwrap();
    assert_parity(&store);
    store.close().unwrap();
    assert_eq!(
        stored_marker(&path),
        None,
        "open backfilled without attesting"
    );
}

#[test]
fn generational_collect_equivalent_across_backends() {
    use ironhorse_snapshot::machine::{checkpoint_to_store, generational_collect, partial_collect};
    // Phase 11's backend-equivalence lock: the generational pass's
    // seed and expansion queries run through the trait — the dense
    // defaults on Memory/File, the reverse-index and region-bounded
    // CTE overrides here — and the outcome must be a pure function of
    // store content, not of which backend answered.
    let cranks = [
        "var keep = 0; var g = 0; var i = 0; var t = 0; \
         keep = { v: 0, w: 0 }; \
         for (i = 0; i < 900; i = i + 1) { keep = { v: i, w: i }; } \
         t = 1; t",
        "var keep; var g; var i; var t; \
         for (i = 0; i < 1200; i = i + 1) { g = { v: i, w: i }; } \
         g = 0; keep = { v: -1, w: -1 }; t = 2; t",
    ];
    let compiled: Vec<(Vec<u8>, Vec<ironhorse_vm::SymbolName>)> =
        cranks.iter().map(|s| compile(s)).collect();

    let run = |store: &mut dyn HeapStore| -> (u32, usize) {
        let mut m = Interp::new();
        m.link_intrinsics(&compiled[0].1);
        assert!(m.run(&compiled[0].0).completed);
        let mut session = begin_store_session(m, &sig(), store)
            .map_err(|(_, e)| e)
            .expect("begin");
        let _ = partial_collect(&mut session, store).expect("boundary collect");
        checkpoint_to_store(&mut session, &sig(), store).expect("checkpoint");
        ironhorse_snapshot::store::validate_store_content(store, &sig())
            .expect("the store validates");
        let (b2, n2) = &compiled[1];
        let b2 = session.machine_mut().relink_crank(b2, n2).expect("relink");
        let o = session.machine_mut().run(&b2);
        assert!(o.completed, "halt: {:?}", o.halt);
        checkpoint_to_store(&mut session, &sig(), store).expect("checkpoint");
        ironhorse_snapshot::store::validate_store_content(store, &sig())
            .expect("the store validates");
        let freed = generational_collect(&mut session, store).expect("generational");
        (freed, session.machine().slots().free_list().len())
    };

    let dir = common::TempDir::new(&format!("ironhorse-query-gc-gen-{}", std::process::id()));
    let mut mem = MemoryStore::new();
    let (freed_mem, fl_mem) = run(&mut mem);
    let mut file = FileStore::open(dir.join("heap.ihstore")).unwrap();
    let (freed_file, fl_file) = run(&mut file);
    let mut sq = SqliteHeapStore::open(dir.join("heap.sqlite")).unwrap();
    let (freed_sq, fl_sq) = run(&mut sq);

    assert!(
        freed_mem > 800,
        "the new dropped chain reclaims: {freed_mem}"
    );
    assert_eq!(freed_mem, freed_file, "freed count: memory vs file");
    assert_eq!(freed_mem, freed_sq, "freed count: memory vs sqlite");
    assert_eq!(fl_mem, fl_file, "free list: memory vs file");
    assert_eq!(fl_mem, fl_sq, "free list: memory vs sqlite");
}
