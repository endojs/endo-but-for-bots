//! The native `lockdown()`'s realm state survives snapshot and store resume.

#[path = "common/twin.rs"]
mod carry;
mod common;
use carry::{compile, crank, sig, twin};

use common::TempDir;

use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_vm::Interp;

/// `try { lockdown(); 'returned' } catch (e) { … }`, the guest-visible
/// second-call contract, as a string.
const SECOND_CALL: &str = "try { lockdown(); 'returned' } catch (e) { e.name + ': ' + e.message }";

/// The second-call contract must not change across persistence.
///
/// `lockdown()` throws `TypeError: lockdown already called` on a realm that has
/// already run it (`fx_lockdown`, `xsLockdown.c:90-92`). That answer comes from
/// `Realm::intrinsics().locked_down`, which lives on an `Rc<Realm>` beside the
/// arena rather than in it — so nothing persisted it, and a restored machine
/// answered `returned` where the uninterrupted one answered the `TypeError`.
///
/// It is not only a wrong answer. A guest that gets `returned` has run the whole
/// operation a second time: five constructor rewrites and a transitive freeze
/// over every boot instance, charged to its meter. `twin` compares computrons as
/// well as values against an uninterrupted machine, so the metering divergence
/// fails this too — and it exercises eager resume, lazy resume and checkpoint.
///
/// Completion is carried in a private boot slot, written only after both
/// constructor rewiring and the transitive freeze have completed.
#[test]
fn the_second_call_still_throws_after_store_resume() {
    let mut memory = MemoryStore::new();
    let seen = twin("lockdown(); 0", &[SECOND_CALL], &mut memory);
    assert_eq!(
        seen.iter()
            .map(|(_, _, value, _)| value.as_str())
            .collect::<Vec<_>>(),
        ["TypeError: lockdown already called"],
    );

    let dir = TempDir::new("ih-lockdown-second-call");
    let mut file = FileStore::open(dir.join("heap.ihstore")).expect("open");
    twin("lockdown(); 0", &[SECOND_CALL], &mut file);
}

/// The same across a raw snapshot blob, the other persistence path, which does
/// not go through the store's manifest at all.
#[test]
fn the_second_call_still_throws_after_a_blob_round_trip() {
    let (bytecode, names) = compile("lockdown(); 0");
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    machine
        .collect_garbage()
        .expect("collect the private marker");

    let bytes = machine.write_snapshot(&sig()).expect("write snapshot");
    let mut restored = from_snapshot_bytes(&bytes, &sig()).expect("restore");
    assert_eq!(
        crank(&mut restored, SECOND_CALL).2,
        crank(&mut machine, SECOND_CALL).2,
        "uninterrupted and restored must answer alike"
    );
    assert_eq!(
        crank(&mut restored, SECOND_CALL).2,
        "TypeError: lockdown already called"
    );
}

/// And the negative: a machine that never locked down must NOT come back
/// reporting that it did, or its first call is refused and the realm stays open.
#[test]
fn a_machine_that_never_locked_down_restores_unlocked() {
    let (bytecode, names) = compile("var answer = 42; answer");
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);

    let bytes = machine.write_snapshot(&sig()).expect("write snapshot");
    let mut restored = from_snapshot_bytes(&bytes, &sig()).expect("restore");
    assert_eq!(
        crank(&mut restored, SECOND_CALL).2,
        "returned",
        "the first call on a restored realm that never ran one must still work"
    );
    assert_eq!(
        crank(&mut restored, "({}).constructor.constructor === Function").2,
        "false",
        "and it must have actually locked down, not merely been allowed to try"
    );
}

/// Step 2 is not evidence that the subsequent harden walk completed.
#[test]
fn a_failed_lockdown_does_not_restore_as_successful() {
    for source in [
        "Object.prototype.extra = new Proxy({}, { preventExtensions() { return false; } }); lockdown()",
        r#"
        var entered = false;
        Object.prototype.extra = new Proxy({}, {
          preventExtensions() {
            if (!entered) {
              entered = true;
              try { lockdown(); } catch (e) {}
            }
            return false;
          }
        });
        lockdown();
        "#,
    ] {
        let mut machine = Interp::new();
        let failed = crank(&mut machine, source);
        assert!(!failed.0, "the trap must refuse lockdown: {failed:?}");
        assert_eq!(failed.1, "Refused(\"lockdown:intrinsic-graph\")");
        // Starting another crank abandons the halted activation. The public
        // interpreter API permits this even though embedders should discard it.
        assert!(crank(&mut machine, "0").0);
        let bytes = machine.write_snapshot(&sig()).expect("write snapshot");
        let mut restored = from_snapshot_bytes(&bytes, &sig()).expect("restore");
        let continuous = crank(&mut machine, SECOND_CALL);
        assert!(
            !continuous.0,
            "a nested call must not mark the unfinished outer walk complete: {continuous:?}"
        );
        assert_eq!(
            crank(&mut restored, SECOND_CALL),
            continuous,
            "restore must not turn an incomplete lockdown into success"
        );
    }
}
