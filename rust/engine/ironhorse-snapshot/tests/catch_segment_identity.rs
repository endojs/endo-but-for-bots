//! Saved catch targets retain code identity through encoding, migration and GC.
use ironhorse_snapshot::CommitToken;
use ironhorse_snapshot::{
    image::{read_machine, write_machine_unchecked, MachineImage},
    machine::{from_snapshot_bytes, resume_from_store, MachineSnapshot},
    store::{
        image_to_batch_unchecked, migrate_store, store_to_image, validate_store, HeapStore,
        HeapStoreCommit, MemoryStore, StoreManifest,
    },
    Signature, SnapshotError,
};
use ironhorse_vm::Interp;

fn crank(vm: &mut Interp, source: &str) -> (String, u64) {
    let (code, names) = ironhorse_compile::compile_atoms(source).unwrap();
    let code = vm
        .relink_crank(&code, &ironhorse_vm::parse_symbols(&names))
        .unwrap();
    let out = vm.run(&code);
    assert!(out.completed, "{:?}", out.halt);
    (out.result, out.meter_raw)
}

fn suspended() -> Interp {
    let mut vm = Interp::new();
    crank(
        &mut vm,
        "var discarded = function () {}; discarded = null; 0",
    );
    crank(
        &mut vm,
        r#"
        var reject, trace = '';
        var gate = new Promise((r, j) => { reject = j; });
        function* generator() {
            try { yield 'ready'; }
            catch (e) { trace += 'g:' + e + ';'; yield 'caught'; }
            finally { trace += 'gf;'; }
        }
        var iterator = generator(); iterator.next();
        async function work() {
            try { await gate; }
            catch (e) { trace += 'a:' + e + ';'; }
            finally { trace += 'af;'; }
        }
        work(); 0
    "#,
    );
    assert_eq!(vm.retained_code_segment_count(), 2);
    vm.collect_garbage().unwrap();
    assert_eq!(vm.retained_code_segment_count(), 1);
    vm
}

fn legacy(image: &mut MachineImage) {
    image.version.format_version = 18;
    for frame in image
        .generators
        .iter_mut()
        .filter_map(|row| row.frame.as_mut())
        .chain(
            image
                .promise_cluster
                .async_instances
                .iter_mut()
                .map(|row| &mut row.frame),
        )
    {
        assert!(!frame.jumps.is_empty());
        for jump in &mut frame.jumps {
            assert_eq!(jump.segment, Some(0));
            jump.segment = None;
        }
    }
}

fn finish(vm: &mut Interp) -> (String, u64) {
    crank(vm, "iterator.throw('g'); reject('a'); 0");
    let result = crank(vm, "iterator.next(); trace");
    assert_eq!(result.0, "g:g;a:a;af;gf;");
    result
}

#[test]
fn compacted_handlers_round_trip_with_explicit_and_legacy_identity() {
    let signature = Signature::new("catch-segment-identity");
    for old in [false, true] {
        let mut continuous = suspended();
        let mut image = continuous.snapshot_image_for_testing(&signature).unwrap();
        if old {
            legacy(&mut image);
        }
        let bytes = write_machine_unchecked(&image);
        let decoded = read_machine(&bytes, &signature).unwrap();
        assert_eq!(decoded, image);
        assert_eq!(write_machine_unchecked(&decoded), bytes);
        let mut resumed = from_snapshot_bytes(&bytes, &signature).unwrap();
        let upgraded = resumed.snapshot_image_for_testing(&signature).unwrap();
        for frame in upgraded
            .generators
            .iter()
            .filter_map(|row| row.frame.as_ref())
            .chain(
                upgraded
                    .promise_cluster
                    .async_instances
                    .iter()
                    .map(|row| &row.frame),
            )
        {
            assert!(frame.jumps.iter().all(|jump| jump.segment == Some(0)));
        }
        assert_eq!(finish(&mut resumed), finish(&mut continuous));
    }
}

#[test]
fn foreign_handler_segments_are_refused_in_both_frame_families() {
    let signature = Signature::new("catch-segment-identity");
    let original = suspended().snapshot_image_for_testing(&signature).unwrap();
    for asynchronous in [false, true] {
        let mut image = original.clone();
        let frame = if asynchronous {
            &mut image.promise_cluster.async_instances[0].frame
        } else {
            image.generators[0].frame.as_mut().unwrap()
        };
        frame.jumps[0].segment = Some(1);
        assert_eq!(
            read_machine(&write_machine_unchecked(&image), &signature).unwrap_err(),
            SnapshotError::Corrupt("generator frame: invalid saved handler")
        );
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
            .unwrap();
        assert!(validate_store(&store, &signature).is_err());
    }
}

#[test]
fn schema29_migration_preserves_payloads() {
    let signature = Signature::new("catch-segment-identity");
    let mut continuous = suspended();
    let mut image = continuous.snapshot_image_for_testing(&signature).unwrap();
    legacy(&mut image);
    let mut store = MemoryStore::new();
    store
        .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
        .unwrap();
    let small = store.read_small_state().unwrap();
    let rows = store_to_image(&store).unwrap();
    let current = store.manifest().unwrap();
    let old = StoreManifest {
        store_schema: 29,
        ..current.clone()
    };
    store.replace_for_migration(&current, &old, &small).unwrap();
    assert!(migrate_store(&mut store, &signature).unwrap());
    // Every step from 29 on is an identity restamp: the manifest comes back
    // at the current schema with its epoch, counters and token.
    assert_eq!(store.manifest().unwrap(), current);
    assert_eq!(store.read_small_state().unwrap(), small);
    assert_eq!(store_to_image(&store).unwrap(), rows);
    assert!(!migrate_store(&mut store, &signature).unwrap());
    let mut resumed = resume_from_store(&store, &signature).unwrap();
    assert_eq!(finish(resumed.machine_mut()), finish(&mut continuous));
}
