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
    assert_eq!(ironhorse_vm::COST_TABLE_VERSION, "ironhorse-meter-5");
    let corpus = include_str!("fixtures/state_golden.tsv");
    assert!(corpus.starts_with("# ironhorse-meter-5 "));
    let format_19_corpus = include_str!("fixtures/state_golden_format_19.tsv");
    let prior_corpus = include_str!("fixtures/state_golden_meter_4.tsv");
    let format_16_corpus = include_str!("fixtures/state_golden_format_16.tsv");
    let controls = include_str!("fixtures/state_golden_reserved_ids.tsv");
    let sig = Signature::new("w4-determinism-corpus");
    let mut labels = BTreeSet::new();
    for line in corpus.lines().skip(1) {
        let f: Vec<_> = line.split('\t').collect();
        assert_eq!(f.len(), 10);
        let label = f[0];
        let format_16: Vec<_> = format_16_corpus
            .lines()
            .skip(1)
            .map(|line| line.split('\t').collect::<Vec<_>>())
            .find(|row| row[0] == label)
            .unwrap();
        let format_19: Vec<_> = format_19_corpus
            .lines()
            .skip(1)
            .map(|line| line.split('\t').collect::<Vec<_>>())
            .find(|row| row[0] == label)
            .unwrap();
        let prior: Vec<_> = prior_corpus
            .lines()
            .skip(1)
            .map(|line| line.split('\t').collect::<Vec<_>>())
            .find(|row| row[0] == label)
            .unwrap();
        assert_eq!(
            (f[7], f[8]),
            (prior[7], prior[8]),
            "execution-only charges stay fixed"
        );
        assert_eq!((f[7], f[8]), (format_16[7], format_16[8]));
        let control: Vec<_> = controls
            .lines()
            .skip(1)
            .map(|line| line.split('\t').collect::<Vec<_>>())
            .find(|row| row[0] == label)
            .unwrap();
        assert!(labels.insert(label));
        for repeat in 0..2 {
            let machine = fresh(f[1]);
            assert_format_19_bytes(&machine, &sig, format_19[5]);
            assert_previous_bytes(&machine, &sig, control[1]);
            assert_format_16_bytes(&machine, &sig, control[2]);
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
                assert_format_19_bytes(&machine, &sig, format_19[9]);
                assert_previous_bytes(&machine, &sig, control[3]);
                assert_format_16_bytes(&machine, &sig, control[4]);
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

/// Explicit format/schema/boot-layout identity regeneration tool. Runtime costs and continuation
/// results must remain unchanged; only persisted byte/seal identities move.
#[test]
#[ignore = "regenerates persisted identities after a reviewed format/schema/boot change"]
fn regenerate_persistence_identities() {
    let corpus = include_str!("fixtures/state_golden.tsv");
    let mut lines = corpus.lines();
    let mut output = format!("{}\n", lines.next().unwrap());
    let mut format19_output = String::from("# current boot heap with format19 marker\n");
    let mut controls = String::from("# reserved symbol ids: label\tinitial-meter4\tinitial-meter5\tfinal-meter4\tfinal-meter5 (format16)\n");
    let sig = Signature::new("w4-determinism-corpus");
    for line in lines {
        let mut f: Vec<String> = line.split('\t').map(str::to_owned).collect();
        assert_eq!(f.len(), 10);
        let machine = fresh(&f[1]);
        assert_eq!(machine.meter_index(), f[7].parse::<u64>().unwrap());
        let mut image = machine.snapshot_image(&sig).unwrap().into_image();
        image.version.format_version = 19;
        let format19_hash = hex_sha256(&ironhorse_snapshot::write_machine_unchecked(&image));
        image.version.format_version = 16;
        image.function_state.native_names = None;
        let format16 = hex_sha256(&ironhorse_snapshot::write_machine_unchecked(&image));
        image.meter.cost_table_version = "ironhorse-meter-4".into();
        let meter4 = hex_sha256(&ironhorse_snapshot::write_machine_unchecked(&image));
        controls.push_str(&format!("{}\t{meter4}\t{format16}", f[0]));
        f[5] = hex_sha256(&machine.write_snapshot(&sig).unwrap());
        let mut store = MemoryStore::new();
        let session = begin_store_session(machine, &sig, &mut store)
            .map_err(|(_, e)| e)
            .unwrap();
        f[6] = store.manifest().unwrap().seal;
        let mut format19_fields = f.clone();
        format19_fields[5] = format19_hash;
        let mut machine = session.into_machine();
        crank(&mut machine, &f[2]);
        assert_eq!(crank(&mut machine, &f[3]), f[4]);
        assert_eq!(machine.meter_index(), f[8].parse::<u64>().unwrap());
        let mut image = machine.snapshot_image(&sig).unwrap().into_image();
        image.version.format_version = 19;
        format19_fields[9] = hex_sha256(&ironhorse_snapshot::write_machine_unchecked(&image));
        format19_output.push_str(&format19_fields.join("\t"));
        format19_output.push('\n');
        image.version.format_version = 16;
        image.function_state.native_names = None;
        let format16 = hex_sha256(&ironhorse_snapshot::write_machine_unchecked(&image));
        image.meter.cost_table_version = "ironhorse-meter-4".into();
        let meter4 = hex_sha256(&ironhorse_snapshot::write_machine_unchecked(&image));
        controls.push_str(&format!("\t{meter4}\t{format16}\n"));
        f[9] = hex_sha256(&machine.write_snapshot(&sig).unwrap());
        output.push_str(&f.join("\t"));
        output.push('\n');
    }
    std::fs::write(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/state_golden_format_19.tsv"
        ),
        format19_output,
    )
    .unwrap();
    std::fs::write(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/state_golden_reserved_ids.tsv"
        ),
        controls,
    )
    .unwrap();
    std::fs::write(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/state_golden.tsv"
        ),
        output,
    )
    .unwrap();
}

// Format-marker control in the current namespace: omit both the later
// format stamp and the format18 boot-native name table from these comparisons.
fn assert_format_16_bytes(machine: &Interp, sig: &Signature, expected: &str) {
    let mut image = machine.snapshot_image(sig).unwrap().into_image();
    image.version.format_version = 16;
    image.function_state.native_names = None;
    assert_eq!(
        hex_sha256(&ironhorse_snapshot::image::write_machine_unchecked(&image)),
        expected
    );
}

// Meter/version-marker control in the current reserved-id namespace.
// Historical corpora independently pin unchanged execution costs.
fn assert_previous_bytes(machine: &Interp, sig: &Signature, expected: &str) {
    let mut image = machine.snapshot_image(sig).unwrap().into_image();
    image.meter.cost_table_version = "ironhorse-meter-4".into();
    image.version.format_version = 16;
    image.function_state.native_names = None;
    assert_eq!(
        hex_sha256(&ironhorse_snapshot::image::write_machine_unchecked(&image)),
        expected
    );
}

fn assert_format_19_bytes(machine: &Interp, sig: &Signature, expected: &str) {
    let mut image = machine.snapshot_image(sig).unwrap().into_image();
    image.version.format_version = 19;
    assert_eq!(
        hex_sha256(&ironhorse_snapshot::image::write_machine_unchecked(&image)),
        expected
    );
}
