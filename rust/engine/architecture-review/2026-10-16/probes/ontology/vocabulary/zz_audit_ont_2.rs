//! Audit probe (ontology/vocabulary): are `EnvironmentId` / `HostRootId`
//! ("stable identifier within a snapshot lineage") stable, or arena slot
//! indices that a later allocation can reuse?
use ironhorse_vm::Machine;

#[test]
fn zz_audit_ont_2() {
    let m = Machine::new();
    // Environment ids across compartment lifetimes.
    let mut env_ids = Vec::new();
    for round in 0..4 {
        let c = m.new_compartment();
        let id = c.snapshot_id();
        println!("round {round}: EnvironmentId={id:?} CompartmentId={:?}", c.global_this());
        env_ids.push(id);
        drop(c);
        let stats = m.collect().expect("collect");
        println!("  collect: reclaimed={} live={}", stats.slots_reclaimed, stats.slots_live);
    }
    // Host root ids across object lifetimes.
    let start = m.start_compartment();
    let mut root_ids = Vec::new();
    for round in 0..4 {
        let src = format!("globalThis.o = {{ round: {round} }}; 0");
        let (code, symbols) = ironhorse_compile::compile_atoms(&src).unwrap();
        let out = start.evaluate_with_symbols(&code, &symbols);
        assert!(out.completed, "{:?}", out.halt);
        let identity = start.global_object_identity("o").expect("identity");
        let id = identity.snapshot_id();
        println!("round {round}: HostRootId={id:?}");
        root_ids.push(id);
        drop(identity);
        let (code, symbols) = ironhorse_compile::compile_atoms("delete globalThis.o; 0").unwrap();
        assert!(start.evaluate_with_symbols(&code, &symbols).completed);
        let stats = m.collect().expect("collect");
        println!("  collect: reclaimed={} live={}", stats.slots_reclaimed, stats.slots_live);
    }
    println!("env ids: {env_ids:?}");
    println!("root ids: {root_ids:?}");
}
