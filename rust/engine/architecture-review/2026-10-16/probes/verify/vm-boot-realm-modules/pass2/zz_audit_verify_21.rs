//! TEMPORARY audit probe (vm-boot-realm-modules). Deleted after the audit.
//! A live machine and its resumed twin run the same crank; `pending_surfaces`
//! is derived at boot and not persisted, so the twin re-completes holders the
//! live machine already completed, and that completion runs the global
//! install pass.
#[path = "common/twin.rs"]
mod carry;

use ironhorse_snapshot::machine::{begin_store_session, resume_from_store};
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_vm::Interp;

fn twin_print(label: &str, first: &str, observation: &str) {
    let (bytecode, names) = carry::compile(first);
    let initial = || {
        let mut machine = Interp::new();
        machine.link_intrinsics(&names);
        let outcome = machine.run(&bytecode);
        assert!(outcome.completed, "initial crank: {:?}", outcome.halt);
        machine
    };
    let mut live = initial();
    let live_seen = carry::crank(&mut live, observation);
    let mut store = MemoryStore::new();
    drop(
        begin_store_session(initial(), &carry::sig(), &mut store)
            .map_err(|(_, error)| error)
            .expect("begin"),
    );
    let mut eager = resume_from_store(&store, &carry::sig()).expect("eager resume");
    let resumed_seen = carry::crank(eager.machine_mut(), observation);
    println!("AUDIT {label} live    = {live_seen:?}");
    println!("AUDIT {label} resumed = {resumed_seen:?}");
    println!("AUDIT {label} agree   = {}", live_seen == resumed_seen);
}

#[test]
fn pending_surfaces_twin() {
    let stack = std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(|| {
            twin_print(
                "assign",
                "Object.getOwnPropertyNames(Boolean.prototype); 0",
                "var parsed = JSON.parse('{\"to' + 'Fixed\":1, \"x\":2}'); \
                 Object.setPrototypeOf(Number.prototype, parsed); \
                 Boolean.prototype.zz = 1; \
                 var seen = []; for (var k in Object(1)) seen.push(k); seen.join()",
            );
            twin_print(
                "define",
                "Object.getOwnPropertyNames(Boolean.prototype); 0",
                "var parsed = JSON.parse('{\"to' + 'Fixed\":1, \"x\":2}'); \
                 Object.setPrototypeOf(Number.prototype, parsed); \
                 Object.defineProperty(Boolean.prototype, 'zz', { value: 1 }); \
                 var seen = []; for (var k in Object(1)) seen.push(k); seen.join()",
            );
            // Pass 2: the shipped consensus workers lock down before the first checkpoint.
            twin_print(
                "lockdown-first",
                "Object.getOwnPropertyNames(Boolean.prototype); lockdown(); 0",
                "var parsed = JSON.parse('{\\"to' + 'Fixed\\":1, \\"x\\":2}'); \
                 Object.setPrototypeOf(Object.create(null), parsed); \
                 try { Boolean.prototype.zz = 1; } catch (e) {} \
                 var seen = []; for (var k in parsed) seen.push(k); seen.join()",
            );
            twin_print(
                "freeze-holder",
                "Object.getOwnPropertyNames(Boolean.prototype); Object.freeze(Boolean.prototype); 0",
                "var parsed = JSON.parse('{\\"to' + 'Fixed\\":1, \\"x\\":2}'); \
                 Object.setPrototypeOf(Number.prototype, parsed); \
                 Boolean.prototype.zz = 1; \
                 var seen = []; for (var k in Object(1)) seen.push(k); seen.join()",
            );
            // Control: no completed holder on the live side.
            twin_print(
                "control",
                "0",
                "var parsed = JSON.parse('{\"to' + 'Fixed\":1, \"x\":2}'); \
                 Object.setPrototypeOf(Number.prototype, parsed); \
                 Boolean.prototype.zz = 1; \
                 var seen = []; for (var k in Object(1)) seen.push(k); seen.join()",
            );
        })
        .unwrap();
    stack.join().unwrap();
}
