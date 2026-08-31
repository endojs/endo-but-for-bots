//! The installed-names floor's OWN locks (the `NFLR` atom / schema-12
//! name-floor section), founded on the miss the Intl carry exposed:
//! its twins first caught the un-carried floor only because an array
//! literal happened to intern `length` and grow the table — a fixture
//! accident, not a lock. These twins pin the floor's contract with NO
//! accidental growth anywhere: a resumed machine's very first
//! NON-GROWING relink must install exactly the backlog the live
//! machine's would (names interned during the live link's install
//! pass, and names the guest interned itself), and must resurrect
//! nothing the guest deleted.

mod common;

use common::TempDir;

use ironhorse_snapshot::machine::{begin_store_session, checkpoint_to_store, resume_from_store};
use ironhorse_snapshot::store::{validate_store, HeapStore, MemoryStore};
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::{parse_symbols, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    (bytecode, parse_symbols(&symbols))
}

/// Relink and run one crank, returning `(completed, halt debug, result,
/// computrons)`. The COMPUTRON count is part of the observation: a
/// resumed machine that answers correctly while charging differently
/// has still diverged, and consensus is on the count as much as the
/// value. Every twin below therefore compares metering too.
fn crank(m: &mut Interp, src: &str) -> (bool, String, String, u64) {
    let (b, n) = compile(src);
    let b = m.relink_crank(&b, &n).expect("relink");
    let o = m.run(&b);
    (o.completed, format!("{:?}", o.halt), o.result, o.computrons)
}

/// Run crank 1 and the observation cranks uninterrupted, and the same
/// cranks across a checkpoint/resume split on `store`; assert the
/// observations agree pairwise and return the continuous ones.
fn twin(crank1: &str, observations: &[&str], store: &mut dyn HeapStore) -> Vec<(bool, String, String, u64)> {
    let (b1, n1) = compile(crank1);

    let mut cont = Interp::new();
    cont.link_intrinsics(&n1);
    assert!(cont.run(&b1).completed, "crank 1 (continuous)");
    let continuous: Vec<_> = observations.iter().map(|s| crank(&mut cont, s)).collect();

    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1 (store)");
    let session = begin_store_session(m, &sig(), store)
        .map_err(|(_, e)| e)
        .expect("begin");
    drop(session);
    let mut session = resume_from_store(store, &sig()).expect("resume");
    let resumed: Vec<_> = observations
        .iter()
        .map(|s| crank(session.machine_mut(), s))
        .collect();
    assert_eq!(continuous, resumed, "resumed observes exactly as uninterrupted");
    checkpoint_to_store(&mut session, &sig(), store).expect("checkpoint after resume");
    validate_store(store, &sig()).expect("post-crank store validates");
    continuous
}

fn assert_twin(name: &str, crank1: &str, observations: &[&str], expect: &[&str]) {
    let mut mem = MemoryStore::new();
    let seen = twin(crank1, observations, &mut mem);
    for got in &seen {
        assert!(got.0, "observation completes: {:?}", got.1);
    }
    let got: Vec<&str> = seen.iter().map(|(_, _, r, _)| r.as_str()).collect();
    assert_eq!(got, expect, "the continuous observations are the real answers");

    let dir = TempDir::new(name);
    let mut file = FileStore::open(dir.join("heap.ihstore")).unwrap();
    twin(crank1, observations, &mut file);
}

/// A name interned DURING the live link's install pass (the `format`
/// accessor key): crank 1 never spells it, and the observation crank
/// introduces no novel name, so the install can come only from the
/// every-relink backlog pass gated by the carried floor.
#[test]
fn a_resumed_non_growing_crank_installs_the_boot_interned_backlog() {
    assert_twin(
        "ih-floor-twin-boot",
        "var lf = 0; var t = 0; \
         lf = new Intl.ListFormat('en', { type: 'conjunction' }); t = 7; t",
        &["var lf; var t; t = typeof lf.format; t"],
        &["function"],
    );
}

/// A name the GUEST interned (a `JSON.parse` key naming an intrinsic):
/// same discipline — the non-growing observation reaches the global
/// only through the floor-gated backlog pass.
#[test]
fn a_resumed_non_growing_crank_installs_a_guest_interned_name() {
    assert_twin(
        "ih-floor-twin-guest",
        "var o = 0; var t = 0; o = JSON.parse('{\"Math\":1}'); t = 7; t",
        &["var o; var t; t = typeof Math; t"],
        &["object"],
    );
}

/// The other direction: a guest DELETION of the boot seed accessor
/// leaves no property in the arena, so neither the restore-time seed
/// rebuild nor any later install pass resurrects it — the resumed
/// machine agrees with the live one's degraded answer.
#[test]
fn a_deleted_seed_accessor_stays_deleted_across_resume() {
    assert_twin(
        "ih-floor-twin-deleted-seed",
        "var nf = 0; var t = 0; var d = 0; \
         nf = new Intl.NumberFormat('en', { style: 'percent' }); \
         d = delete Intl.NumberFormat.prototype.format; t = '' + d; t",
        &["var nf; var t; t = typeof nf.format; t"],
        &["undefined"],
    );
}
