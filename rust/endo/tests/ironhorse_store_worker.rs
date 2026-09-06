//! The supervisor's store-backed worker-heap option, exercised end to
//! end (designs/ironhorse-snapshot-store-seam.md § supervisor wiring):
//! a `PersistentMachine` opened through `HeapStoreOptions` builds guest
//! state across cranks with a checkpoint per completed crank, rewinds a
//! crashed crank to the last checkpoint, runs a partial collection at a
//! boundary, suspends through the supervisor's store-aware record (no
//! CAS key — the database is the durable state), and resumes from that
//! record with state, epoch chain, and determinism intact.

#![cfg(feature = "ironhorse-engine")]

use endo::ironhorse_engine::engine::{
    CadencePolicy, HeapStoreOptions, MachineError, MeterBounds, PersistentMachine,
};
use endo::supervisor::Supervisor;

#[test]
fn store_backed_worker_lifecycle_through_the_supervisor() {
    let dir = tempfile::tempdir().expect("temp dir");
    let options = HeapStoreOptions {
        path: dir.path().join("worker-heap.sqlite"),
        signature: "endor-ironhorse-worker-v1".to_string(),
        cadence: CadencePolicy::default(),
        meter: MeterBounds::default(),
    };

    // --- Fresh open: epoch 1 is the boot machine. -------------------
    let mut machine = PersistentMachine::open(&options).expect("fresh open");
    assert_eq!(machine.epoch().expect("epoch"), 1, "boot commit");

    // Crank 1 builds guest state; a completed crank checkpoints, so
    // the epoch advances before the outcome is visible.
    let outcome = machine
        .eval(
            "var n = 0; var junk = 0; var i = 0; var probe = 0; \
             probe = { v: 0, w: 0 }; \
             for (i = 0; i < 100; i = i + 1) { n = n + 1; } \
             for (i = 0; i < 500; i = i + 1) { junk = { v: i, w: i }; } \
             junk = 0; n",
        )
        .expect("crank 1");
    assert_eq!(outcome.result, "100");
    assert!(outcome.computrons > 0, "the meter is real");
    assert_eq!(machine.epoch().expect("epoch"), 2);

    // Crank 2 continues the SAME heap (globals persist). This crank
    // compiles to the SAME symbol table, which is the simple case;
    // since the G2 ledger, `eval` no longer REQUIRES that — it relinks
    // a divergent table instead, which this file's relink tests below
    // exercise directly. The live `probe` object lets a crank reference
    // the property names v/w without allocating.
    let outcome = machine
        .eval("var n; var junk; var i; var probe; i = probe.v + probe.w; n = n + 1")
        .expect("crank 2");
    assert_eq!(outcome.result, "101");
    assert_eq!(machine.epoch().expect("epoch"), 3);

    // --- Crashed crank: rewind, never persist. ----------------------
    // The throw arrives AFTER a mutation; neither the mutation nor the
    // crank survives — the machine rewinds to epoch 3's state and the
    // epoch does not advance.
    match machine.eval("var n; var junk; var i; var probe; i = probe.v + probe.w; n = n + 1000; throw n;") {
        Err(MachineError::Halt(_)) => {}
        other => panic!("expected a halt, got {other:?}"),
    }
    assert_eq!(machine.epoch().expect("epoch"), 3, "no checkpoint for a crashed crank");
    let outcome = machine
        .eval("var n; var junk; var i; var probe; i = probe.v + probe.w; n")
        .expect("crank after rewind");
    assert_eq!(outcome.result, "101", "the partial crank's effects are gone");
    assert_eq!(machine.epoch().expect("epoch"), 4);

    // --- Per-crank RELINKING (side-table ledger G2). -----------------
    // A crank whose compiled table differs from the persisted one used
    // to be refused; now its ID operands are rewritten onto the
    // persisted table (new names append) and it runs like any other.
    let outcome = machine.eval("var zzz = 1; zzz").expect("misaligned crank relinks");
    assert_eq!(outcome.result, "1");
    assert_eq!(machine.epoch().expect("epoch"), 5, "the relinked crank checkpointed");
    // The prior names still bind their state after the extension…
    let outcome = machine
        .eval("var n; var junk; var i; var probe; i = probe.v + probe.w; n")
        .expect("prior-name crank after the relink");
    assert_eq!(outcome.result, "101", "prior state addressable after extension");
    assert_eq!(machine.epoch().expect("epoch"), 6);
    // …and the appended name persisted with its value.
    let outcome = machine.eval("var zzz; zzz").expect("appended-name crank");
    assert_eq!(outcome.result, "1", "the appended global survived its crank");
    assert_eq!(machine.epoch().expect("epoch"), 7);

    // --- Partial collection at the boundary. ------------------------
    // The dropped `junk` chain is page-isolated garbage; the
    // summary-driven collector reclaims some of it without touching
    // row content — and the collection is made DURABLE by a
    // checkpoint before `collect` returns (the review's finding: an
    // unrecorded collection would be discarded by close), so the
    // epoch advances.
    let freed = machine.collect().expect("partial collect");
    assert!(freed > 0, "the dropped chain is reclaimable: {freed}");
    assert_eq!(machine.epoch().expect("epoch"), 8, "the collection checkpointed");

    // --- Suspend through the supervisor. ----------------------------
    // The database is the durable state: the suspend record carries
    // the path, no CAS key, and close leaves a self-contained file.
    let (sup, _outbox) = Supervisor::new();
    let handle = sup.alloc_handle();
    sup.mark_suspended_store(handle, machine.heap_store_path().to_path_buf());
    machine.close().expect("close folds the WAL");
    assert!(sup.is_suspended(handle));
    let suspended = sup.take_suspended(handle).expect("suspended record");
    // A resume path that cannot serve the record (the Ironhorse
    // envelope gap) puts it back untouched; round-trip that API.
    sup.put_suspended(handle, suspended);
    assert!(sup.is_suspended(handle), "the record survives a put-back");
    let suspended = sup.take_suspended(handle).expect("suspended record, again");
    assert!(suspended.sha256.is_empty(), "store-backed workers have no CAS key");
    let heap_store = suspended.heap_store.expect("the record carries the heap path");

    // --- Resume from the suspend record. ----------------------------
    let mut machine = PersistentMachine::open(&HeapStoreOptions {
        path: heap_store,
        signature: options.signature.clone(),
        cadence: CadencePolicy::default(),
        meter: MeterBounds::default(),
    })
    .expect("resume open");
    assert_eq!(machine.epoch().expect("epoch"), 8, "the epoch chain continues");
    let outcome = machine
        .eval("var n; var junk; var i; var probe; i = probe.v + probe.w; n = n + 1")
        .expect("crank after resume");
    assert_eq!(outcome.result, "102", "guest state survived suspend/resume");
    assert_eq!(machine.epoch().expect("epoch"), 9);
    // The pre-suspend collection was durable: collecting again finds
    // nothing left of the junk chain (before the fix, close discarded
    // the reclamation and this second collect re-freed it).
    let freed_again = machine.collect().expect("second partial collect");
    assert_eq!(freed_again, 0, "the reclamation survived suspend/resume");
    machine.close().expect("close");

    // --- The signature gate refuses a foreign worker. ---------------
    match PersistentMachine::open(&HeapStoreOptions {
        path: dir.path().join("worker-heap.sqlite"),
        signature: "some-other-host-surface".to_string(),
        cadence: CadencePolicy::default(),
        meter: MeterBounds::default(),
    }) {
        Err(MachineError::Store(e)) => {
            assert!(e.contains("Signature"), "refused by the signature gate: {e}");
        }
        Ok(_) => panic!("a foreign signature must be refused"),
        Err(other) => panic!("expected a store refusal, got {other}"),
    }
}

#[test]
fn an_empty_first_crank_does_not_link_the_table() {
    // wave-3 finding: a live machine that "linked" an EMPTY symbol
    // table refused a later named crank, while the same store
    // REOPENED accepted it (`open` derives linked-ness from the
    // persisted name count). An empty table constrains nothing —
    // there are no ids to misalign — so eval now leaves the machine
    // unlinked and the live machine and its reopened twin accept the
    // same next crank.
    let dir = tempfile::tempdir().expect("temp dir");
    let options = HeapStoreOptions {
        path: dir.path().join("worker-heap.sqlite"),
        signature: "endor-ironhorse-worker-v1".to_string(),
        cadence: CadencePolicy::default(),
        meter: MeterBounds::default(),
    };
    let mut machine = PersistentMachine::open(&options).expect("fresh open");
    let outcome = machine.eval("1 + 2").expect("literal crank");
    assert_eq!(outcome.result, "3");
    assert_eq!(machine.epoch().expect("epoch"), 2, "the literal crank checkpointed");

    // LIVE: the first NAMED crank links now (before the fix this arm
    // refused with SymbolMismatch while the reopened path accepted).
    let outcome = machine.eval("var q = 0; q = 7; q").expect("named crank, live");
    assert_eq!(outcome.result, "7");
    assert_eq!(machine.epoch().expect("epoch"), 3);
    machine.close().expect("close");

    // REOPENED: the linked table is enforced as usual from here on.
    let mut machine = PersistentMachine::open(&options).expect("reopen");
    let outcome = machine.eval("var q; q").expect("named crank after reopen");
    assert_eq!(outcome.result, "7", "the named state persisted");
    assert_eq!(machine.epoch().expect("epoch"), 4);
    let outcome = machine
        .eval("var zzz = 1; zzz")
        .expect("a divergent table relinks after reopen too");
    assert_eq!(outcome.result, "1");
    machine.close().expect("close");
}

#[test]
fn cadence_policy_defers_flushes_and_schedules_collections() {
    // Deferred item I: checkpoint_every batches flushes (epoch
    // advances only at the flush points), the widened rewind window
    // is exactly the documented trade, close's final flush closes it,
    // and collect_every runs the durable collection on the crank
    // schedule.
    let dir = tempfile::tempdir().expect("temp dir");
    let options = HeapStoreOptions {
        path: dir.path().join("cadence-heap.sqlite"),
        signature: "endor-ironhorse-worker-v1".to_string(),
        cadence: CadencePolicy {
            checkpoint_every: 3,
            collect_every: 0,
        },
        meter: MeterBounds::default(),
    };

    // --- Deferred flushes. ------------------------------------------
    let mut machine = PersistentMachine::open(&options).expect("fresh open");
    assert_eq!(machine.epoch().expect("epoch"), 1, "boot commit");
    let out = machine.eval("var n = 0; n = 1; n").expect("crank 1");
    assert_eq!(out.result, "1");
    assert_eq!(machine.epoch().expect("epoch"), 1, "crank 1 deferred");
    machine.eval("var n; n = n + 1; n").expect("crank 2");
    assert_eq!(machine.epoch().expect("epoch"), 1, "crank 2 deferred");
    machine.eval("var n; n = n + 1; n").expect("crank 3");
    assert_eq!(machine.epoch().expect("epoch"), 2, "third crank flushed");

    // --- The widened rewind window. ---------------------------------
    // One deferred good crank, then a halting crank: the rewind
    // discards BOTH (back to the flush at n == 3).
    machine.eval("var n; n = n + 1; n").expect("crank 4 (deferred)");
    assert_eq!(machine.epoch().expect("epoch"), 2, "crank 4 deferred");
    match machine.eval("var n; n = n + 100; throw n;") {
        Err(MachineError::Halt(_)) => {}
        other => panic!("expected a halt, got {other:?}"),
    }
    let out = machine.eval("var n; n").expect("read after rewind");
    assert_eq!(
        out.result, "3",
        "the rewind window discarded the deferred crank too (the documented trade)"
    );
    // That read crank flushed IMMEDIATELY rather than deferring: a
    // rewind forces the next completed crank to checkpoint, because a
    // workload that halts more often than every N cranks would
    // otherwise never reach N and never make any progress durable at
    // all (review wave 5).
    assert_eq!(
        machine.epoch().expect("epoch"),
        3,
        "the crank after a rewind is made durable regardless of cadence"
    );

    // --- close() flushes the pending tail. --------------------------
    // The cadence has resumed, so this crank defers again; close makes
    // it durable.
    machine.eval("var n; n").expect("crank 6 (deferred again)");
    assert_eq!(machine.epoch().expect("epoch"), 3, "cadence resumed after the rewind");
    machine.close().expect("close flushes");
    let mut machine = PersistentMachine::open(&options).expect("reopen");
    assert_eq!(machine.epoch().expect("epoch"), 4, "close's final flush landed");
    let out = machine.eval("var n; n").expect("state after reopen");
    assert_eq!(out.result, "3");
    machine.close().expect("close");

    // --- collect_every (two-policy comparison, non-vacuous). --------
    // The SAME reclaimable workload — 500 dropped two-property objects,
    // the page-isolated-garbage shape the lifecycle test's manual
    // collect proves reclaimable — run under two policies. The
    // difference in what a manual collect finds afterward is the
    // positive evidence the SCHEDULE reclaimed: baseline frees >0,
    // scheduled run frees 0 because the schedule already did it.
    let build = "var junk = 0; var i = 0; \
                 for (i = 0; i < 500; i = i + 1) { junk = { v: i, w: i }; } \
                 junk = 0; i";
    // Baseline: no scheduled collection; a manual collect after two
    // cranks reclaims the dropped objects.
    let base_opts = HeapStoreOptions {
        path: dir.path().join("cadence-collect-base.sqlite"),
        signature: "endor-ironhorse-worker-v1".to_string(),
        cadence: CadencePolicy { checkpoint_every: 1, collect_every: 0 },
        meter: MeterBounds::default(),
    };
    let mut base = PersistentMachine::open(&base_opts).expect("open base");
    base.eval(build).expect("baseline garbage crank");
    base.eval("var junk; var i; i").expect("baseline crank 2");
    assert_eq!(base.epoch().expect("epoch"), 3, "baseline: no scheduled collect");
    let baseline_freed = base.collect().expect("baseline manual collect");
    assert!(baseline_freed > 0, "the workload IS reclaimable: {baseline_freed}");
    base.close().expect("close base");

    // Scheduled: collect_every=2 fires the durable collection at crank
    // 2 — flush (epoch 3) then the collection's own checkpoint (epoch
    // 4). A manual collect right after then finds NOTHING, because the
    // schedule already reclaimed exactly what the baseline's manual
    // collect had to.
    let sched_opts = HeapStoreOptions {
        path: dir.path().join("cadence-collect-sched.sqlite"),
        signature: "endor-ironhorse-worker-v1".to_string(),
        cadence: CadencePolicy { checkpoint_every: 1, collect_every: 2 },
        meter: MeterBounds::default(),
    };
    let mut sched = PersistentMachine::open(&sched_opts).expect("open sched");
    sched.eval(build).expect("garbage crank");
    assert_eq!(sched.epoch().expect("epoch"), 2, "flushed, not yet collected");
    sched.eval("var junk; var i; i").expect("second crank");
    assert_eq!(
        sched.epoch().expect("epoch"),
        4,
        "the scheduled collection checkpointed after the flush",
    );
    let after_schedule = sched.collect().expect("manual collect");
    assert_eq!(after_schedule, 0, "the schedule already reclaimed the chain");
    sched.close().expect("close sched");
}

#[test]
fn collect_every_is_not_starved_by_throwing_cranks() {
    // Wave-4 P2: a halt used to zero the collect clock, so under any
    // throw-bearing workload collect_every never fired. Now a rewind
    // only discards the PENDING count; the durable cranks keep their
    // collect-clock credit, so the schedule fires on schedule.
    let dir = tempfile::tempdir().expect("temp dir");
    let options = HeapStoreOptions {
        path: dir.path().join("starve-heap.sqlite"),
        signature: "endor-ironhorse-worker-v1".to_string(),
        cadence: CadencePolicy { checkpoint_every: 1, collect_every: 2 },
        meter: MeterBounds::default(),
    };
    let mut machine = PersistentMachine::open(&options).expect("open");
    // Crank 1 (completed): builds reclaimable garbage. epoch 1 -> 2.
    machine
        .eval(
            "var junk = 0; var i = 0; \
             for (i = 0; i < 500; i = i + 1) { junk = { v: i, w: i }; } \
             junk = 0; i",
        )
        .expect("garbage crank");
    assert_eq!(machine.epoch().expect("epoch"), 2);
    // A THROWING crank between the two good ones — the starvation
    // trigger. It rewinds (epoch stands at 2); pre-fix this zeroed the
    // collect clock.
    match machine.eval("var i; i = 1; throw i;") {
        Err(MachineError::Halt(_)) => {}
        other => panic!("expected a halt, got {other:?}"),
    }
    assert_eq!(machine.epoch().expect("epoch"), 2, "the throw rewound");
    // Crank 2 (completed) is the SECOND durable crank since the last
    // collect, so the schedule MUST fire: flush (epoch 3) + the
    // collection's checkpoint (epoch 4).
    machine.eval("var junk; var i; i").expect("second good crank");
    assert_eq!(
        machine.epoch().expect("epoch"),
        4,
        "collect_every fired despite the intervening throw (not starved)",
    );
    let after = machine.collect().expect("manual collect");
    assert_eq!(after, 0, "the scheduled collection reclaimed the garbage");
    machine.close().expect("close");
}

/// Review wave 5: `checkpoint_every: N` STARVED — completely — on any
/// workload that halts more often than every N cranks. A halt rewinds
/// to the last checkpoint and drops the pending count, so the counter
/// never reached N, nothing was ever made durable, and the machine made
/// no progress at all. That is not the bounded rewind window the policy
/// documents; it is total loss, and the wave-4 pass fixed the same
/// shape for `collect_every` while leaving this one.
///
/// A rewind now forces the NEXT completed crank to checkpoint, so the
/// cadence self-tunes to a halt-heavy workload and resumes afterwards.
#[test]
fn checkpoint_every_is_not_starved_by_throwing_cranks() {
    let dir = tempfile::tempdir().expect("temp dir");
    let options = HeapStoreOptions {
        path: dir.path().join("starve-checkpoint.sqlite"),
        signature: "endor-ironhorse-worker-v1".to_string(),
        cadence: CadencePolicy { checkpoint_every: 3, collect_every: 0 },
        meter: MeterBounds::default(),
    };
    let mut machine = PersistentMachine::open(&options).expect("open");
    let start = machine.epoch().expect("epoch");

    // Alternate completed and throwing cranks, never reaching three
    // pending in a row. Pre-fix the epoch never moves off `start`.
    for round in 0..4 {
        machine
            .eval(&format!("var keep = 0; keep = {round}; keep"))
            .expect("good crank");
        match machine.eval("var boom; boom = 1; throw boom;") {
            Err(MachineError::Halt(_)) => {}
            other => panic!("round {round}: expected a halt, got {other:?}"),
        }
    }
    let epoch = machine.epoch().expect("epoch");
    assert!(
        epoch > start,
        "checkpoint_every starved: epoch never left {start} across four \
         completed cranks, because each halt dropped the pending count \
         before the third one could arrive",
    );

    // The durable state is real, not just an advanced counter: reopen
    // and read back the last completed crank's value.
    machine.close().expect("close");
    let mut reopened = PersistentMachine::open(&options).expect("reopen");
    let out = reopened.eval("var keep; keep").expect("read back");
    assert_eq!(out.result, "3", "the last completed crank was made durable");
    reopened.close().expect("close");
}

/// A healthy machine reports no failed scheduled collections. The
/// counter itself is the signal a supervisor polls; driving a REAL
/// collection failure needs a fault seam the SQLite backend does not
/// have, so the failure path is reviewed rather than tested, and this
/// pins the accessor and its clean baseline.
#[test]
fn a_healthy_machine_reports_no_failed_collections() {
    let dir = tempfile::tempdir().expect("temp dir");
    let options = HeapStoreOptions {
        path: dir.path().join("collect-signal.sqlite"),
        signature: "endor-ironhorse-worker-v1".to_string(),
        cadence: CadencePolicy { checkpoint_every: 1, collect_every: 2 },
        meter: MeterBounds::default(),
    };
    let mut machine = PersistentMachine::open(&options).expect("open");
    for i in 0..4 {
        machine
            .eval(&format!("var junk = 0; junk = {{ v: {i} }}; junk = 0; {i}"))
            .expect("crank");
    }
    assert_eq!(
        machine.failed_collections(),
        (0, None),
        "the scheduled collections all succeeded"
    );
    machine.close().expect("close");
}

/// Review wave 5's P0, reproduced by two reviewers independently: the
/// collect schedule used to live in a session counter that `open()`
/// zeroed, so a plain suspend/resume — no fault, no throw — restarted it
/// mid-window and the two replicas diverged in DURABLE BYTES while their
/// per-crank results and computrons stayed identical.
///
/// The schedule now derives from the manifest's absolute completed-crank
/// total (store schema 8), so suspending is invisible to it. This asserts
/// the property the `CadencePolicy` rustdoc claims: same policy, same
/// program, same bytes — whatever the suspend history.
#[test]
fn the_collect_schedule_survives_a_suspend() {
    let dir = tempfile::tempdir().expect("temp dir");

    // Enough cranks to cross several collect boundaries, and a workload
    // that actually produces garbage so a collection MOVES the free list
    // (a fixture that frees nothing would agree vacuously).
    const CRANKS: usize = 13;
    // The `{v,w}` chain the lifecycle test proves is reclaimable — one
    // small object per crank frees nothing measurable, which would make
    // the fork assertions below pass vacuously (caught by bite-checking
    // this very test).
    let prog = |i: usize| {
        format!(
            "var keep; var junk; var j; \
             for (j = 0; j < 400; j = j + 1) {{ junk = {{ v: j, w: j }}; }} \
             junk = 0; keep = {{ v: {i} }}; {i}"
        )
    };
    let policy = || CadencePolicy {
        checkpoint_every: 1,
        collect_every: 3,
    };

    // A: one continuous session.
    let path_a = dir.path().join("a.sqlite");
    let mut a = PersistentMachine::open(&HeapStoreOptions {
        path: path_a.clone(),
        signature: "ironhorse-worker-v1".to_string(),
        cadence: policy(),
        meter: MeterBounds::default(),
    })
    .expect("open A");
    for i in 0..CRANKS {
        a.eval(&prog(i)).expect("A crank");
    }
    let epoch_a = a.epoch().expect("A epoch");
    a.close().expect("close A");

    // B: identical program and policy, but closed and reopened between
    // every crank — the seam's primary operation.
    let path_b = dir.path().join("b.sqlite");
    for i in 0..CRANKS {
        let mut b = PersistentMachine::open(&HeapStoreOptions {
            path: path_b.clone(),
            signature: "ironhorse-worker-v1".to_string(),
            cadence: policy(),
            meter: MeterBounds::default(),
        })
        .expect("open B");
        b.eval(&prog(i)).expect("B crank");
        b.close().expect("close B");
    }

    // Same durable state, reached through completely different suspend
    // histories. Roots are the store-native identity; free_len is the
    // collector's own footprint, and is what forked before the fix.
    let ma = read_manifest(&path_a);
    let mb = read_manifest(&path_b);
    // The fork assertions come FIRST so a regression names the property
    // that broke rather than the bookkeeping that revealed it.
    assert_eq!(
        ma.free_len, mb.free_len,
        "the collect schedule forked across the suspend (free lists differ)"
    );
    assert_eq!(
        ma.root, mb.root,
        "the collect schedule forked across the suspend (roots differ)"
    );
    // And the counter that carries the schedule really is durable.
    assert_eq!(ma.cranks, CRANKS as u64, "A recorded every completed crank");
    assert_eq!(mb.cranks, CRANKS as u64, "B recorded every completed crank");
    assert_eq!(ma.epoch, epoch_a, "A's epoch is what it reported");
}

/// Read a store's manifest without going through a machine.
fn read_manifest(path: &std::path::Path) -> ironhorse_snapshot::store::StoreManifest {
    use ironhorse_snapshot::store::HeapStore;
    let store = ironhorse_store_sqlite::SqliteHeapStore::open(path).expect("open for manifest");
    store.manifest().expect("manifest")
}
