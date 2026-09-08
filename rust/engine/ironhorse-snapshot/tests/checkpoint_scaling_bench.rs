//! F043: checkpoint cost for an unchanged live array after a `1 + 1` crank.
use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, resume_from_store, MachineSnapshot,
};
use ironhorse_snapshot::store::{HeapStore, MemoryStore};
use ironhorse_snapshot::Signature;
use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

#[test]
#[ignore = "checkpoint growth benchmark: release timing"]
fn unchanged_live_arrays_do_not_make_checkpoints_linear() {
    assert!(!cfg!(debug_assertions));
    let signature = Signature::new("ironhorse-worker-v1");
    let (hot, _) = ironhorse_compile::compile_atoms("1 + 1").unwrap();
    let mut previous = None;
    let mut expected_raw = None;
    let mut failures = Vec::new();
    for n in [1000, 10000, 50000] {
        let source = format!("var a=[]; for(var i=0;i<{n};i++){{a[i]=i;}} 0");
        let (code, symbols) = ironhorse_compile::compile_atoms(&source).unwrap();
        let mut machine = Interp::new();
        machine.link_intrinsics(&parse_symbols(&symbols));
        assert!(machine.run(&code).completed);
        let mut store = MemoryStore::new();
        let mut session = begin_store_session(machine, &signature, &mut store)
            .map_err(|(_, error)| error)
            .unwrap();
        let stored_small_bytes = store.read_small_state().unwrap().len();
        let mut times = Vec::new();
        let mut raw = 0;
        for round in 0..8 {
            let before = session.machine().meter_index();
            let result = session.machine_mut().run(&hot);
            assert!(result.completed, "{:?}", result.halt);
            assert_eq!(result.result, "2");
            raw = result.meter_raw - before;
            if let Some(old) = expected_raw {
                assert_eq!(raw, old);
            }
            expected_raw = Some(raw);
            let start = Instant::now();
            checkpoint_to_store(&mut session, &signature, &mut store).unwrap();
            let seconds = start.elapsed().as_secs_f64();
            let stats = store.last_commit_stats();
            assert_eq!(stats.slot_pages_written, 0);
            assert_eq!(stats.chunk_extents_written, 0);
            if round > 0 {
                times.push(seconds);
            }
        }
        times.sort_by(f64::total_cmp);
        let seconds = times[3];
        // Outside the timer: unchanged arrays must survive the checkpoint.
        // Comparing the complete image catches a falsely fast dropped section.
        let restored = resume_from_store(&store, &signature).unwrap();
        assert_eq!(
            restored.machine().snapshot_image(&signature).unwrap(),
            session.machine().snapshot_image(&signature).unwrap()
        );
        println!("CHECKPOINT n={n} seconds={seconds:.9} raw={raw} stored_small_bytes={stored_small_bytes}");
        if let Some(old) = previous {
            if seconds / old >= 2.5 {
                failures.push(n);
            }
        }
        previous = Some(seconds);
    }
    assert!(
        failures.is_empty(),
        "checkpoint time scales with unchanged live state at {failures:?}"
    );
}
