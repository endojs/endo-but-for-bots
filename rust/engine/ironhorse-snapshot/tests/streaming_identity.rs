//! The streaming container writer is byte-identical to the image writer.
//!
//! `MachineSnapshot::write_snapshot` and `write_snapshot_to` stream the
//! `XS_M` container straight from the live arenas and side tables
//! (WASM-BLOCKERS.md B7, "Checkpointing needs several copies of the
//! heap"), while `write_machine` over `snapshot_image` encodes a copied
//! image. Every seal and hash in the system (the CAS key, the store's root
//! hash, the golden vectors) is a function of these bytes, so the two
//! writers must agree on every section kind, on every fixture, and
//! through every kind of sink.
mod common;

use ironhorse_snapshot::format::CANONICAL_ATOM_ORDER;
use ironhorse_snapshot::image::write_machine;
use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot, MachineSnapshotError};
use ironhorse_snapshot::sha256::hex_sha256;
use ironhorse_snapshot::{AtomReader, Signature};
use ironhorse_vm::{parse_symbols, Interp};
use std::io::{self, Write};

/// A quiescent machine whose container carries every optional atom the
/// writer knows. (A frozen container cannot stand in for it: a container
/// carries its boot layout's fingerprint, which differs between hosts and
/// builds and is refused before adoption, `BootLayoutMismatch`, which is
/// also why none of the older frozen fixtures under `tests/fixtures` can be
/// compared live and why the store fixtures are regenerated per run.)
const ALL_SECTIONS: &str = include_str!("fixtures/streaming-baseline.js");

fn baseline_signature() -> Signature {
    Signature::new("ironhorse-footprint-v1")
}

fn ran(source: &str) -> Interp {
    let mut machine = Interp::new();
    let (code, symbols) = ironhorse_compile::compile_atoms(source).expect("fixture compiles");
    machine.link_intrinsics(&parse_symbols(&symbols));
    let outcome = machine.run(&code);
    assert!(outcome.completed, "{:?}", outcome.halt);
    machine
}

/// The image writer's bytes: the reference every streaming path must match.
fn image_bytes(machine: &Interp, signature: &Signature) -> Vec<u8> {
    write_machine(&machine.snapshot_image(signature).unwrap()).unwrap()
}

/// A writer that accepts at most `max` bytes per call, so the streamed
/// bytes cross `write` boundaries the buffered sink did not choose.
struct Dribble {
    out: Vec<u8>,
    max: usize,
}

impl Write for Dribble {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let accepted = buf.len().min(self.max);
        self.out.extend_from_slice(&buf[..accepted]);
        Ok(accepted)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A writer that fails once it has accepted `room` bytes.
struct Full {
    accepted: usize,
    room: usize,
}

impl Write for Full {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.accepted + buf.len() > self.room {
            return Err(io::Error::other("no space left on device"));
        }
        self.accepted += buf.len();
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Every streaming path of `machine` agrees with the image writer.
fn assert_streams_identically(name: &str, machine: &Interp, signature: &Signature) -> Vec<u8> {
    let reference = image_bytes(machine, signature);
    let streamed = machine.write_snapshot(signature).unwrap();
    assert!(
        streamed == reference,
        "{name}: write_snapshot differs from the image writer"
    );
    // The pre-sized buffer is exactly the container: no slack, no growth.
    assert_eq!(
        streamed.capacity(),
        streamed.len(),
        "{name}: buffer pre-size"
    );

    let mut plain = Vec::new();
    let written = machine.write_snapshot_to(signature, &mut plain).unwrap();
    assert!(plain == reference, "{name}: write_snapshot_to differs");
    assert_eq!(written, reference.len() as u64, "{name}: reported length");

    for max in [1, 7, 4096, 64 * 1024 - 1] {
        let mut dribble = Dribble {
            out: Vec::new(),
            max,
        };
        machine.write_snapshot_to(signature, &mut dribble).unwrap();
        assert!(dribble.out == reference, "{name}: {max}-byte writes differ");
    }

    let dir = common::TempDir::new("ih-streaming-identity");
    let path = dir.join(format!("{name}.xsm"));
    let file = std::fs::File::create(&path).unwrap();
    let digest = machine.write_snapshot_to_file(signature, file).unwrap();
    assert!(
        std::fs::read(&path).unwrap() == reference,
        "{name}: write_snapshot_to_file differs"
    );
    assert_eq!(digest, hex_sha256(&reference), "{name}: the CAS key");
    streamed
}

#[test]
fn every_section_kind_streams_identically() {
    let machine = ran(ALL_SECTIONS);
    let streamed = assert_streams_identically("all-sections", &machine, &baseline_signature());
    // The fixture is only a lock on every section encoder if every atom is
    // present: the writer omits an empty optional atom, so an atom missing
    // here would be an encoder the comparison never ran.
    let atoms: Vec<_> = AtomReader::parse(&streamed)
        .unwrap()
        .atoms()
        .iter()
        .map(|atom| atom.tag)
        .collect();
    assert_eq!(atoms, CANONICAL_ATOM_ORDER, "every atom the writer knows");
}

#[test]
fn a_container_written_by_the_image_writer_restores_and_streams_to_the_same_bytes() {
    // The pre-streaming path, retained unchanged: an image of the machine,
    // encoded by `write_machine`. Through a restore of that container, the
    // streaming writer gives back exactly its bytes: a stored container, a
    // live machine, and the new writer agree.
    let signature = baseline_signature();
    let written_before = image_bytes(&ran(ALL_SECTIONS), &signature);
    let machine = from_snapshot_bytes(&written_before, &signature).unwrap();
    let streamed = assert_streams_identically("restored", &machine, &signature);
    assert!(
        streamed == written_before,
        "a restored machine streams the container it was restored from"
    );
}

#[test]
fn the_golden_corpus_streams_identically() {
    // `fixtures/state_golden.tsv`: name, program, crank, observation,
    // expected, and the pinned digests; the program is the carried state.
    let corpus = include_str!("fixtures/state_golden.tsv");
    let signature = Signature::new("state-golden");
    let mut seen = 0;
    for line in corpus.lines().filter(|line| !line.starts_with('#')) {
        let fields: Vec<&str> = line.split('\t').collect();
        let (name, program) = (fields[0], fields[1]);
        let machine = ran(program);
        assert_streams_identically(name, &machine, &signature);
        seen += 1;
    }
    assert!(seen >= 16, "the corpus ran: {seen} programs");
}

#[test]
fn an_empty_machine_streams_identically() {
    let signature = Signature::new("empty");
    let machine = Interp::new();
    assert_streams_identically("empty", &machine, &signature);
}

#[test]
fn a_failing_writer_reports_its_error_and_nothing_else() {
    let machine = ran(ALL_SECTIONS);
    let signature = baseline_signature();
    let mut full = Full {
        accepted: 0,
        room: 1000,
    };
    match machine.write_snapshot_to(&signature, &mut full) {
        Err(MachineSnapshotError::Io(error)) => {
            assert_eq!(error.to_string(), "no space left on device");
        }
        other => panic!("expected the writer's error, got {other:?}"),
    }
}
