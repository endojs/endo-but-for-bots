//! Golden bytes and seal roots for nonempty carried side tables. These vectors
//! run on the same debug/release and Linux/macOS CI lanes as the runtime corpus.
use ironhorse_snapshot::{
    machine::{
        begin_store_session, from_snapshot_bytes, resume_from_store, resume_from_store_lazy,
        MachineSnapshot, MachineSnapshotError,
    },
    sha256::hex_sha256,
    store::{HeapStore, MemoryStore},
    Signature,
};
use ironhorse_vm::{parse_symbols, Interp};
use std::{cell::RefCell, collections::BTreeSet, rc::Rc};

fn fresh(source: &str) -> Interp {
    let (code, names) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut m = Interp::new();
    m.link_intrinsics(&parse_symbols(&names));
    m.arm_meter(1000, Box::new(|_| true));
    let outcome = m.run(&code);
    assert!(outcome.completed, "{source}: {:?}", outcome.halt);
    m
}

fn crank(m: &mut Interp, source: &str) -> String {
    let (code, names) = ironhorse_compile::compile_atoms(source).unwrap();
    let code = m.relink_crank(&code, &parse_symbols(&names)).unwrap();
    let outcome = m.run(&code);
    assert!(outcome.completed, "{source}: {:?}", outcome.halt);
    outcome.result
}

#[test]
fn carried_state_has_frozen_bytes_seals_costs_and_continuations() {
    assert_eq!(ironhorse_vm::COST_TABLE_VERSION, "ironhorse-meter-3");
    let corpus = include_str!("fixtures/state_golden.tsv");
    assert!(corpus.starts_with("# ironhorse-meter-3 "));
    let sig = Signature::new("w4-determinism-corpus");
    let mut labels = BTreeSet::new();
    for line in corpus.lines().skip(1) {
        let f: Vec<_> = line.split('\t').collect();
        assert_eq!(f.len(), 10);
        let label = f[0];
        assert!(labels.insert(label));
        for repeat in 0..2 {
            let machine = fresh(f[1]);
            let bytes = machine.write_snapshot(&sig).unwrap();
            assert_eq!(
                hex_sha256(&bytes),
                f[5],
                "{label} repeat {repeat}: initial bytes"
            );
            assert_eq!(
                machine.meter_index(),
                f[7].parse::<u64>().unwrap(),
                "{label}: initial meter"
            );
            let store = Rc::new(RefCell::new(MemoryStore::new()));
            let continuous = begin_store_session(machine, &sig, &mut *store.borrow_mut())
                .map_err(|(_, e)| e)
                .unwrap();
            assert_eq!(
                store.borrow().manifest().unwrap().seal,
                f[6],
                "{label}: initial seal"
            );
            let blob = from_snapshot_bytes(&bytes, &sig).unwrap();
            let eager = resume_from_store(&*store.borrow(), &sig).unwrap();
            let lazy = resume_from_store_lazy(store, &sig).unwrap();
            for (path, mut machine) in [
                ("continuous", continuous.into_machine()),
                ("container", blob),
                ("eager", eager.into_machine()),
                ("lazy", lazy.into_machine()),
            ] {
                // A snapshot materializes lazy pages. Preserve cold first-touch
                // restoration until the continuation; its final hash checks all
                // remaining rows too.
                if path != "lazy" {
                    assert_eq!(
                        hex_sha256(&machine.write_snapshot(&sig).unwrap()),
                        f[5],
                        "{label}/{path}: restore bytes"
                    );
                }
                machine.reattach_meter_host(Box::new(|_| true));
                crank(&mut machine, f[2]);
                assert_eq!(
                    crank(&mut machine, f[3]),
                    f[4],
                    "{label}/{path}: continuation"
                );
                assert_eq!(
                    machine.meter_index(),
                    f[8].parse::<u64>().unwrap(),
                    "{label}/{path}: final raw cost"
                );
                assert_eq!(
                    hex_sha256(&machine.write_snapshot(&sig).unwrap()),
                    f[9],
                    "{label}/{path}: final bytes"
                );
            }
        }
    }
    assert_eq!(labels.len(), 16);
}

#[test]
fn unsupported_async_generator_state_remains_an_explicit_refusal() {
    let machine = fresh("async function* g() { yield 10; yield 20; } var it = g(); it.next(); 0");
    assert!(
        matches!(machine.write_snapshot(&Signature::new("w4-determinism-corpus")),
        Err(MachineSnapshotError::PendingStateUnsupported { row }) if row == "an async generator whose state does not yet persist")
    );
}
