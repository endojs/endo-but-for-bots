//! Architecture review F014: metering must not be fail-open. The host
//! callback cannot travel in a snapshot, so a machine restored from an
//! ARMED snapshot without reattaching one used to report itself metered
//! while never consulting anybody — an unbounded run wearing a bound's
//! name. Now every check point on such a machine aborts, and the
//! embedder's `attach_meter_host` is the one resume form that always
//! lands in a consistent state.

use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_snapshot::Signature;
use ironhorse_vm::{Halt, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

const LOOP: &str = "var j = 0; for (j = 0; j < 100000; j++) { j = j; } j";

/// An armed machine, checkpointed after one cheap crank.
fn armed_snapshot(interval: u64) -> Vec<u8> {
    let (b, n) = compile("var j = 0; j = 1; j");
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    m.arm_meter(interval, Box::new(|_| true));
    assert!(m.run(&b).completed);
    assert!(m.meter_is_armed());
    m.write_snapshot(&sig())
        .expect("quiescent machine snapshots")
}

#[test]
fn a_restored_armed_machine_without_a_host_fails_closed() {
    let bytes = armed_snapshot(1_000);
    let mut restored = from_snapshot_bytes(&bytes, &sig()).expect("restore");
    assert!(
        restored.meter_is_armed(),
        "the armed state rides the snapshot"
    );
    assert!(!restored.meter_host_attached(), "the host does not");

    let (b, n) = compile(LOOP);
    let b = restored.relink_crank(&b, &n).expect("relink");
    let out = restored.run(&b);
    assert!(
        matches!(out.halt, Halt::MeterAbort),
        "armed without a host must abort at the first check point, not \
         run unbounded: {:?}",
        out.halt
    );
}

#[test]
fn attach_meter_host_reattaches_under_the_same_interval() {
    let bytes = armed_snapshot(1_000);
    let mut restored = from_snapshot_bytes(&bytes, &sig()).expect("restore");
    let carried = restored.meter_state();
    restored.attach_meter_host(1_000, Box::new(|_| true));
    assert_eq!(
        restored.meter_state(),
        carried,
        "the same interval is the pure reattach: no counter moves"
    );
    let (b, n) = compile(LOOP);
    let b = restored.relink_crank(&b, &n).expect("relink");
    assert!(restored.run(&b).completed);
}

#[test]
fn attach_meter_host_rearms_an_unarmed_or_differently_armed_snapshot() {
    // Written un-armed (a store from before the embedder bounded its
    // cranks): attaching arms it now, from the preserved index.
    let (b0, n0) = compile("var j = 0; j = 1; j");
    let mut m = Interp::new();
    m.link_intrinsics(&n0);
    assert!(m.run(&b0).completed);
    let spent = m.meter_index();
    let bytes = m.write_snapshot(&sig()).expect("snapshot");
    let mut restored = from_snapshot_bytes(&bytes, &sig()).expect("restore");
    assert!(!restored.meter_is_armed());
    restored.attach_meter_host(10, Box::new(|_| false));
    assert!(restored.meter_is_armed());
    assert_eq!(restored.meter_index(), spent, "the index is preserved");
    let (b, n) = compile(LOOP);
    let b = restored.relink_crank(&b, &n).expect("relink");
    assert!(matches!(restored.run(&b).halt, Halt::MeterAbort));

    // Written under another interval: re-armed under the configured one.
    let bytes = armed_snapshot(1_000);
    let mut restored = from_snapshot_bytes(&bytes, &sig()).expect("restore");
    let before = restored.meter_state();
    restored.attach_meter_host(2_000, Box::new(|_| true));
    let after = restored.meter_state();
    assert_eq!(after.index, before.index);
    assert_ne!(
        after.interval, before.interval,
        "the window is the configured one"
    );
}
