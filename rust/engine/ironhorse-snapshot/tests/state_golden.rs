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

fn corpus() -> &'static str {
    if ironhorse_vm::MATH_PROVIDER == "platform" {
        include_str!("fixtures/state_golden.tsv")
    } else {
        include_str!("fixtures/state_golden_libm.tsv")
    }
}

// Older fixture hashes describe the platform signature. Normalize only the
// provider fingerprint for their byte-level comparison, preserving all state,
// cost and format checks under both providers.
fn platform_signature(sig: &Signature) -> Signature {
    let mut encoded = sig.encode();
    encoded[4..36].copy_from_slice(include_bytes!("fixtures/math-platform-boot.bin"));
    Signature::decode(&encoded).unwrap()
}

/// A historical format / meter stamp, as a way of asking what identity the
/// CURRENT heap encodes under it. These controls describe today's heap under
/// yesterday's markers; they are not reconstructions of historical bytes.
#[derive(Clone, Copy)]
enum Marker {
    Format16,
    Format19,
    Format20,
    Format21,
    Meter4Format16,
}

/// The digest `marker` stamps onto `machine`'s heap — the compute half of the
/// `assert_*_bytes` pairs below, split out so
/// [`regenerate_persistence_identities`] writes exactly what they read. One
/// definition, so a regenerated fixture cannot drift from its assertion.
fn marker_bytes(machine: &Interp, sig: &Signature, marker: Marker) -> String {
    let mut image = machine.snapshot_image(sig).unwrap().into_image();
    image.signature = platform_signature(sig);
    match marker {
        Marker::Format19 => image.version.format_version = 19,
        Marker::Format20 => image.version.format_version = 20,
        Marker::Format21 => image.version.format_version = 21,
        // Format-marker control in the current namespace: omit both the later
        // format stamp and the format18 boot-native name table.
        Marker::Format16 => {
            image.version.format_version = 16;
            image.function_state.native_names = None;
        }
        // Meter/version-marker control in the current reserved-id namespace.
        // Historical corpora independently pin unchanged execution costs.
        Marker::Meter4Format16 => {
            image.meter.cost_table_version = "ironhorse-meter-4".into();
            image.version.format_version = 16;
            image.function_state.native_names = None;
        }
    }
    hex_sha256(&ironhorse_snapshot::image::write_machine_unchecked(&image))
}

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
    let corpus = corpus();
    assert!(corpus.starts_with("# ironhorse-meter-5 "));
    let format_21_corpus = include_str!("fixtures/state_golden_format_21.tsv");
    let format_20_corpus = include_str!("fixtures/state_golden_format_20.tsv");
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
        let format_21: Vec<_> = format_21_corpus
            .lines()
            .skip(1)
            .map(|line| line.split('\t').collect::<Vec<_>>())
            .find(|row| row[0] == label)
            .unwrap();
        let format_20: Vec<_> = format_20_corpus
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
            assert_format_21_bytes(&machine, &sig, format_21[5]);
            assert_format_20_bytes(&machine, &sig, format_20[5]);
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
                assert_format_21_bytes(&machine, &sig, format_21[9]);
                assert_format_20_bytes(&machine, &sig, format_20[9]);
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

/// Both async shapes that once refused a snapshot now write one, and what
/// they write reads back. The `Array.fromAsync` arm is the last of them
/// (format 24, architecture finding F127's last clause); before it, a machine
/// holding one refused with `PendingStateUnsupported`.
///
/// This lives beside the golden corpus rather than in the carry suite because
/// it is the assertion that the corpus's own gate — `write_snapshot`, not the
/// container reader — admits these machines at all.
#[test]
fn both_async_generator_and_from_async_state_now_write_and_read_back() {
    let sig = Signature::new("w4-determinism-corpus");
    for source in [
        "async function* g() { yield 10; yield 20; } var it = g(); it.next(); 0",
        "var p = Array.fromAsync([new Promise(function () {})]); 0",
    ] {
        let machine = fresh(source);
        let bytes = machine
            .write_snapshot(&sig)
            .unwrap_or_else(|e| panic!("{source}: {e:?}"));
        from_snapshot_bytes(&bytes, &sig).unwrap_or_else(|e| panic!("{source}: {e:?}"));
    }
    // The control must guard the SAME gate the two arms above used to trip.
    // A quiescence control does not: it lives on a different branch of
    // `write_snapshot`, so the whole pending-row gate could be deleted and
    // this test would stay green while claiming otherwise. The `$262` host is
    // a quiescent machine that the PENDING-ROW gate still refuses, which is
    // the branch that has to remain live for the admissions to mean anything.
    let (code, names) = ironhorse_compile::compile_atoms("var x = 0; x = 41; x").unwrap();
    let mut machine = Interp::new();
    // BEFORE `link_intrinsics`, which is the installer's own precondition.
    machine.install_test262_host();
    machine.link_intrinsics(&parse_symbols(&names));
    assert!(machine.run(&code).completed);
    assert!(
        machine.is_quiescent(),
        "the refusal must not be quiescence's"
    );
    assert!(matches!(
        machine.write_snapshot(&sig),
        Err(MachineSnapshotError::PendingStateUnsupported { row })
            if row == "a test262 `$262` host object, which no snapshot carries"
    ));
}

/// An identity fixture, read back so regeneration rewrites only the digest
/// columns the assertions actually consume and leaves every other byte of the
/// file alone.
struct Table {
    name: &'static str,
    header: String,
    rows: Vec<Vec<String>>,
}

impl Table {
    fn read(dir: &std::path::Path, name: &'static str) -> Self {
        let text = std::fs::read_to_string(dir.join(name)).unwrap();
        let mut lines = text.lines();
        let header = lines.next().unwrap().to_owned();
        let rows = lines
            .map(|line| line.split('\t').map(str::to_owned).collect())
            .collect();
        Self { name, header, rows }
    }

    fn set(&mut self, label: &str, column: usize, value: String) {
        let row = self
            .rows
            .iter_mut()
            .find(|row| row[0] == label)
            .unwrap_or_else(|| panic!("{}: no row for {label}", self.name));
        row[column] = value;
    }

    fn write(&self, dir: &std::path::Path) {
        let mut out = format!("{}\n", self.header);
        for row in &self.rows {
            out.push_str(&row.join("\t"));
            out.push('\n');
        }
        std::fs::write(dir.join(self.name), out).unwrap();
    }
}

/// Explicit format/schema/boot-layout identity regeneration tool. Runtime costs and continuation
/// results must remain unchanged; only persisted byte/seal identities move.
///
/// That sentence is the whole review. A digest is not reviewable by reading it,
/// so what makes rewriting one safe is that this re-derives each row and
/// ASSERTS the columns that carry meaning — the continuation result and both
/// meter indices — before it writes the columns that carry none. Hand-editing a
/// failing hash to whatever the code now produces asserts nothing and will
/// absorb a bug; this cannot.
///
/// `state_golden_meter_4.tsv` and `state_golden_format_16.tsv` are deliberately
/// NOT written. The corpus test reads only their execution-cost columns, as the
/// control saying a format or boot change left runtime costs alone, so
/// rewriting them would retire that check rather than satisfy it. For the same
/// reason nothing here touches `ironhorse-vm`'s `computrons.tsv`, whose values
/// are costs a human can actually read.
///
/// Run it for BOTH providers — plain, then with
/// `--features ironhorse-vm/deterministic-math` — since each writes only its
/// own corpus and the platform fingerprint is derivable under `platform` alone.
#[test]
#[ignore = "regenerates persisted identities after a reviewed format/schema/boot change"]
fn regenerate_persistence_identities() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let sig = Signature::new("w4-determinism-corpus");
    let main_name = if ironhorse_vm::MATH_PROVIDER == "platform" {
        "state_golden.tsv"
    } else {
        "state_golden_libm.tsv"
    };
    let mut main = Table::read(&dir, main_name);
    let mut format_21 = Table::read(&dir, "state_golden_format_21.tsv");
    let mut format_20 = Table::read(&dir, "state_golden_format_20.tsv");
    let mut format_19 = Table::read(&dir, "state_golden_format_19.tsv");
    let mut controls = Table::read(&dir, "state_golden_reserved_ids.tsv");
    // The cost controls, read to re-check rather than to rewrite.
    let prior = Table::read(&dir, "state_golden_meter_4.tsv");
    let format_16 = Table::read(&dir, "state_golden_format_16.tsv");

    for index in 0..main.rows.len() {
        let f = main.rows[index].clone();
        assert_eq!(f.len(), 10);
        let label = f[0].as_str();

        // Costs are the invariant, in this row and in both historical corpora.
        for (control, name) in [(&prior, "meter-4"), (&format_16, "format-16")] {
            let row = control
                .rows
                .iter()
                .find(|row| row[0] == label)
                .unwrap_or_else(|| panic!("{}: no row for {label}", control.name));
            assert_eq!(
                (&f[7], &f[8]),
                (&row[7], &row[8]),
                "{label}: {name} execution-only charges stay fixed"
            );
        }

        let machine = fresh(&f[1]);
        assert_eq!(
            machine.meter_index(),
            f[7].parse::<u64>().unwrap(),
            "{label}: initial meter"
        );
        format_21.set(label, 5, marker_bytes(&machine, &sig, Marker::Format21));
        format_20.set(label, 5, marker_bytes(&machine, &sig, Marker::Format20));
        format_19.set(label, 5, marker_bytes(&machine, &sig, Marker::Format19));
        controls.set(
            label,
            1,
            marker_bytes(&machine, &sig, Marker::Meter4Format16),
        );
        controls.set(label, 2, marker_bytes(&machine, &sig, Marker::Format16));
        main.rows[index][5] = hex_sha256(&machine.write_snapshot(&sig).unwrap());

        let mut store = MemoryStore::new();
        let session = begin_store_session(machine, &sig, &mut store)
            .map_err(|(_, e)| e)
            .unwrap();
        main.rows[index][6] = store.manifest().unwrap().seal;

        let mut machine = session.into_machine();
        crank(&mut machine, &f[2]);
        assert_eq!(crank(&mut machine, &f[3]), f[4], "{label}: continuation");
        assert_eq!(
            machine.meter_index(),
            f[8].parse::<u64>().unwrap(),
            "{label}: final meter"
        );
        format_21.set(label, 9, marker_bytes(&machine, &sig, Marker::Format21));
        format_20.set(label, 9, marker_bytes(&machine, &sig, Marker::Format20));
        format_19.set(label, 9, marker_bytes(&machine, &sig, Marker::Format19));
        controls.set(
            label,
            3,
            marker_bytes(&machine, &sig, Marker::Meter4Format16),
        );
        controls.set(label, 4, marker_bytes(&machine, &sig, Marker::Format16));
        main.rows[index][9] = hex_sha256(&machine.write_snapshot(&sig).unwrap());
    }

    main.write(&dir);
    for table in [&format_21, &format_20, &format_19, &controls] {
        table.write(&dir);
    }
    // The platform boot fingerprint the historical corpora normalize to. It is
    // bytes 4..36 of any signature, and only derivable under the provider it
    // names — under `libm` the committed bytes are the whole point and stand.
    if ironhorse_vm::MATH_PROVIDER == "platform" {
        std::fs::write(
            dir.join("math-platform-boot.bin"),
            &Signature::new("boot-fingerprint").encode()[4..36],
        )
        .unwrap();
    }
    println!("fixtures written under {} — commit them", dir.display());
}

fn assert_format_16_bytes(machine: &Interp, sig: &Signature, expected: &str) {
    assert_eq!(marker_bytes(machine, sig, Marker::Format16), expected);
}

fn assert_previous_bytes(machine: &Interp, sig: &Signature, expected: &str) {
    assert_eq!(marker_bytes(machine, sig, Marker::Meter4Format16), expected);
}

fn assert_format_20_bytes(machine: &Interp, sig: &Signature, expected: &str) {
    assert_eq!(marker_bytes(machine, sig, Marker::Format20), expected);
}

fn assert_format_19_bytes(machine: &Interp, sig: &Signature, expected: &str) {
    assert_eq!(marker_bytes(machine, sig, Marker::Format19), expected);
}

#[test]
fn math_profile_refuses_a_platform_snapshot_in_deterministic_configuration() {
    let machine = fresh("1");
    let signature = Signature::new("math-profile");
    let platform = platform_signature(&signature);
    if ironhorse_vm::MATH_PROVIDER == "platform" {
        assert_eq!(signature.encode(), platform.encode());
    } else {
        assert_ne!(signature.encode(), platform.encode());
        let mut image = machine.snapshot_image(&signature).unwrap().into_image();
        image.signature = platform.clone();
        let bytes = ironhorse_snapshot::image::write_machine_unchecked(&image);
        assert!(matches!(
            from_snapshot_bytes(&bytes, &platform),
            Err(ironhorse_snapshot::SnapshotError::BootLayoutMismatch { .. })
        ));
    }
}

fn assert_format_21_bytes(machine: &Interp, sig: &Signature, expected: &str) {
    assert_eq!(marker_bytes(machine, sig, Marker::Format21), expected);
}
