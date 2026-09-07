//! The test262 `$262` host object is harness-only (architecture review
//! F143). A default machine's global surface must be auditable, and `$262`
//! carries `detachArrayBuffer`, a memory-detach primitive a hardened realm
//! must never expose. `Interp::new` therefore builds no `$262`; only an
//! explicit `install_test262_host` — which the conformance harness calls
//! before linking, mirroring the oracle shim — makes it reachable.
//!
//! Two invariants that used to live only in that method's prose are
//! enforced now, and pinned at the bottom of this file.
//!
//! **"The harness never checkpoints."** The host and its native are
//! minted above `boot_slot_count`, carried by no atom, and re-derived by
//! nothing on resume — restore boots a DEFAULT machine, which installs no
//! host. The persist gate refuses a machine that STORED the native, which
//! covers two of the three ways a guest can touch `$262`, but not the
//! third:
//!
//! | guest program                    | gate, before this was fixed |
//! |----------------------------------|-----------------------------|
//! | `$262.detachArrayBuffer(b)`      | refuses                     |
//! | `var f = $262.detachArrayBuffer` | refuses                     |
//! | `typeof $262`                    | **passed** — the hole       |
//!
//! The third row stores no function reference, so the gate's heap walk
//! found nothing: the checkpoint succeeded and the resumed machine
//! silently had no `$262` for a later crank to name. The gate now refuses
//! on the host's PRESENCE, so all three rows fail closed.
//!
//! **"Call it before `link_intrinsics`."** The link pass binds a name by
//! looking it up in `intrinsics`; an entry inserted afterwards is never
//! reconsidered for the ids that pass already handled. Inverting the
//! order used to answer `typeof $262 === "undefined"` on a harness
//! machine with no diagnostic at all. It panics now.

use ironhorse_vm::Interp;

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

const PROBE: &str = "var out = {}; out.v = typeof $262; out.v";

const DETACH: &str = "var b = new ArrayBuffer(8); var out = {}; \
                      $262.detachArrayBuffer(b); \
                      out.v = b.byteLength + ':' + b.detached; out.v";

#[test]
fn a_default_machine_has_no_test262_host() {
    let (bytecode, names) = compile(PROBE);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    let outcome = machine.run(&bytecode);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, "undefined", "`$262` leaked into a default machine");
}

#[test]
fn a_default_machine_cannot_detach_through_the_host() {
    // Naming `$262.detachArrayBuffer` on a default machine is a plain
    // unresolvable reference, caught like any other.
    let (bytecode, names) = compile(
        "var b = new ArrayBuffer(8); var out = {}; \
         try { $262.detachArrayBuffer(b); out.v = 'detached'; } catch (e) { out.v = e.name; } \
         out.v + ':' + b.byteLength",
    );
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    let outcome = machine.run(&bytecode);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, "ReferenceError:8");
}

#[test]
fn the_harness_install_exposes_a_working_test262_host() {
    for (src, expected) in [(PROBE, "object"), (DETACH, "0:true")] {
        let (bytecode, names) = compile(src);
        let mut machine = Interp::new();
        machine.install_test262_host();
        machine.link_intrinsics(&names);
        let outcome = machine.run(&bytecode);
        assert!(outcome.completed, "{src}\n  halted: {:?}", outcome.halt);
        assert_eq!(outcome.result, expected, "{src}");
    }
}

#[test]
fn the_harness_install_is_idempotent() {
    let (bytecode, names) = compile(DETACH);
    let mut machine = Interp::new();
    machine.install_test262_host();
    machine.install_test262_host();
    machine.link_intrinsics(&names);
    let outcome = machine.run(&bytecode);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, "0:true");
}

/// Run one crank on a harness machine (host installed, then linked).
fn harness(src: &str) -> Interp {
    let (bytecode, names) = compile(src);
    let mut machine = Interp::new();
    machine.install_test262_host();
    machine.link_intrinsics(&names);
    let outcome = machine.run(&bytecode);
    assert!(outcome.completed, "{src}\n  halted: {:?}", outcome.halt);
    machine
}

/// A machine carrying the host cannot be checkpointed — every way a
/// guest can touch `$262`, including the one that stores nothing.
///
/// The `typeof` row is the whole point. The gate's heap walk refuses a
/// stored reference to a native above `boot_slot_count`, so the other two
/// rows were already refused; a guest that only observes the binding
/// stores no such reference, and its checkpoint used to succeed onto a
/// resumed machine that had silently lost the host. Refusing on presence
/// closes that, and a regression that goes back to inferring the answer
/// from stored references alone fails on the `typeof` row here.
#[test]
fn a_machine_carrying_the_test262_host_refuses_to_persist() {
    for src in [
        "var t = 0; t = typeof $262; t",
        "var f = 0; f = $262.detachArrayBuffer; typeof f",
        "var b = 0; var t = 0; b = new ArrayBuffer(8); \
         $262.detachArrayBuffer(b); t = b.byteLength; t",
    ] {
        let machine = harness(src);
        assert_eq!(
            machine.stored_unpersistable_row(),
            Some("a test262 `$262` host object, which no snapshot carries"),
            "{src:?} must refuse to persist"
        );
        assert_eq!(
            machine.stored_unpersistable_row_at_checkpoint(),
            Some("a test262 `$262` host object, which no snapshot carries"),
            "{src:?} must refuse at a checkpoint too"
        );
    }
}

/// The refusal is narrow: it costs a DEFAULT machine nothing. A gate that
/// refused ordinary programs would be worse than the hole it closes.
#[test]
fn a_default_machine_still_persists() {
    for src in [
        "var t = 0; t = 1; t",
        "var b = 0; var t = 0; b = new ArrayBuffer(8); b.transfer(); t = b.byteLength; t",
    ] {
        let (bytecode, names) = compile(src);
        let mut machine = Interp::new();
        machine.link_intrinsics(&names);
        let outcome = machine.run(&bytecode);
        assert!(outcome.completed, "{src}\n  halted: {:?}", outcome.halt);
        assert_eq!(
            machine.stored_unpersistable_row(),
            None,
            "{src:?} must stay persistable"
        );
    }
}

/// Installing after the link pass panics instead of yielding a machine
/// whose `$262` is silently unreachable.
#[test]
#[should_panic(expected = "install_test262_host must be called BEFORE link_intrinsics")]
fn installing_after_the_link_pass_panics() {
    let (_, names) = compile(PROBE);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    machine.install_test262_host();
}

/// The idempotent second call is not the inverted order, so it must not
/// trip the assertion even though it lands after linking — the harness's
/// own wiring is allowed to be defensive.
#[test]
fn a_repeat_install_after_linking_is_still_a_no_op() {
    let (bytecode, names) = compile(DETACH);
    let mut machine = Interp::new();
    machine.install_test262_host();
    machine.link_intrinsics(&names);
    machine.install_test262_host();
    let outcome = machine.run(&bytecode);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, "0:true");
}
