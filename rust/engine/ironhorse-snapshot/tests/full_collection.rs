//! The production exact collector releases chunks and weak entries durably.
use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, full_collect, resume_from_store, MachineSnapshot,
};
use ironhorse_snapshot::store::{HeapStore, MemoryStore};
use ironhorse_snapshot::Signature;
use ironhorse_vm::Interp;

fn run(vm: &mut Interp, source: &str) -> ironhorse_vm::RunOutcome {
    let (code, names) = ironhorse_compile::compile_atoms(source).unwrap();
    let code = vm
        .relink_crank(&code, &ironhorse_vm::parse_symbols(&names))
        .unwrap();
    let out = vm.run(&code);
    assert!(out.completed, "{:?}", out.halt);
    out
}

#[test]
fn production_full_collection_releases_weak_entries_and_chunk_garbage() {
    let signature = Signature::new("full-collection");
    let mut vm = Interp::new();
    run(&mut vm, "var wm=new WeakMap(), ws=new WeakSet(), live={}; wm.set(live,'live'); ws.add(live); var i; for(i=0;i<100;i++){var k={}; wm.set(k,'dead'+i); ws.add(k);} k=null; var s=''; for(i=0;i<500;i++){s=s+'abcdefgh';} s=null;");
    let entries = |vm: &Interp| {
        vm.collections_snapshot()
            .iter()
            .map(|r| r.3.len())
            .sum::<usize>()
    };
    let before_entries = entries(&vm);
    let mut store = MemoryStore::new();
    let mut session = begin_store_session(vm, &signature, &mut store)
        .map_err(|(_, e)| e)
        .unwrap();
    let before_chunks = session.machine().chunks().byte_size();
    let stats = full_collect(&mut session, &store).unwrap();
    assert!(stats.slots_reclaimed >= 100, "{stats:?}");
    assert!(entries(session.machine()) + 190 < before_entries);
    assert!(session.machine().chunks().byte_size() < before_chunks / 2);
    checkpoint_to_store(&mut session, &signature, &mut store).unwrap();
    let mut restored = resume_from_store(&store, &signature).unwrap();
    assert_eq!(
        session.machine().write_snapshot(&signature).unwrap(),
        restored.machine().write_snapshot(&signature).unwrap()
    );
    let source = "wm.get(live)+':'+wm.has(live)+':'+ws.has(live)+':'+typeof(new Error('x').stack)";
    let expected = run(session.machine_mut(), source);
    let actual = run(restored.machine_mut(), source);
    assert_eq!(actual.result, "live:true:true:string");
    assert_eq!(actual.result, expected.result);
    assert_eq!(actual.meter_raw, expected.meter_raw);
    assert_eq!(
        store.manifest().unwrap().collections,
        0,
        "mechanics do not choose or record a schedule"
    );
}

#[test]
fn full_collection_refuses_unsafe_or_stale_boundaries_before_mutation() {
    use ironhorse_snapshot::store::StoreError;
    let signature = Signature::new("full-admission");
    let mut store = MemoryStore::new();
    let mut session = begin_store_session(Interp::new(), &signature, &mut store)
        .map_err(|(_, e)| e)
        .unwrap();
    let before = session.machine().write_snapshot(&signature).unwrap();
    let mut other = resume_from_store(&store, &signature).unwrap();
    run(other.machine_mut(), "var different=1");
    checkpoint_to_store(&mut other, &signature, &mut store).unwrap();
    assert!(matches!(
        full_collect(&mut session, &store),
        Err(StoreError::BaselineMismatch { .. })
    ));
    assert_eq!(
        session.machine().write_snapshot(&signature).unwrap(),
        before
    );
    assert!(session.machine().slots().dirty_pages().is_empty());
    assert!(session.machine().chunks().dirty_extents().is_empty());

    let mut session = resume_from_store(&store, &signature).unwrap();
    run(session.machine_mut(), "different=2");
    let before = session.machine().write_snapshot(&signature).unwrap();
    let dirty = session.machine().slots().dirty_pages();
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| full_collect(
            &mut session,
            &store
        )))
        .is_err()
    );
    assert_eq!(
        session.machine().write_snapshot(&signature).unwrap(),
        before
    );
    assert_eq!(session.machine().slots().dirty_pages(), dirty);
    assert!(session.machine().is_quiescent());

    let mut session = resume_from_store(&store, &signature).unwrap();
    let (code, names) = ironhorse_compile::compile_atoms("throw 42").unwrap();
    let code = session
        .machine_mut()
        .relink_crank(&code, &ironhorse_vm::parse_symbols(&names))
        .unwrap();
    assert!(!session.machine_mut().run(&code).completed);
    let before_free = session.machine().slots().free_list().to_vec();
    let before_stack = session.machine().stack_slots().to_vec();
    let before_chunks = session.machine().chunks().raw_vec();
    assert_eq!(
        full_collect(&mut session, &store),
        Err(StoreError::MachineNotQuiescent)
    );
    assert_eq!(session.machine().slots().free_list(), before_free);
    assert_eq!(session.machine().stack_slots(), before_stack);
    assert_eq!(session.machine().chunks().raw_vec(), before_chunks);
    assert_eq!(session.collections(), 0);
}
