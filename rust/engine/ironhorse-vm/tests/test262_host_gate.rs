//! The test262 `$262` host object is harness-only (architecture review
//! F143). A default machine's global surface must be auditable, and `$262`
//! carries `detachArrayBuffer`, a memory-detach primitive a hardened realm
//! must never expose. `Interp::new` therefore builds no `$262`; only an
//! explicit `install_test262_host` — which the conformance harness calls
//! before linking, mirroring the oracle shim — makes it reachable.

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
