//! SCRATCH (review probe) — delete after the run.

use ironhorse_snapshot::machine::{begin_store_session, resume_from_store, MachineSnapshot};
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::Interp;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

const PRE: &str = "var g; var p; var q; var t; var o; \
     if (0) { new Promise(function (res) { g = res; }); new Proxy(g, {}); o = {}; o.x = g; } ";

fn gate_of(name: &str, setup: &str) {
    let (b1, n1) = compile(&format!("{PRE}{setup}"));
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    let out = m.run(&b1);
    assert!(out.completed, "{name}: setup halted {:?}", out.halt);
    println!("[{name}] gate: {:?}", m.stored_unpersistable_row());
}

fn probe(name: &str, setup: &str, observe: &str) {
    let (b1, n1) = compile(&format!("{PRE}{setup}"));
    let (b2, n2) = compile(&format!("{PRE}{observe}"));
    assert_eq!(n1, n2, "{name}: both cranks must intern the same symbols");

    let mut cont = Interp::new();
    cont.link_intrinsics(&n1);
    let o1 = cont.run(&b1);
    assert!(o1.completed, "{name}: setup crank halted: {:?}", o1.halt);
    let continuous = cont.run(&b2);
    println!(
        "[{name}] uninterrupted: completed={} result={:?} halt={:?}",
        continuous.completed, continuous.result, continuous.halt
    );

    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "{name}: setup crank (store)");
    println!("[{name}] gate: {:?}", m.stored_unpersistable_row());

    let mut store = MemoryStore::new();
    match begin_store_session(m, &sig(), &mut store) {
        Ok(s) => {
            println!("[{name}] begin_store_session: ADMITTED");
            drop(s);
        }
        Err((_, e)) => {
            println!("[{name}] begin_store_session: REFUSED {e:?}");
            return;
        }
    }
    let mut session = match resume_from_store(&store, &sig()) {
        Ok(s) => s,
        Err(e) => {
            println!("[{name}] resume: REFUSED {e:?}");
            return;
        }
    };
    let resumed = session.machine_mut().run(&b2);
    println!(
        "[{name}] resumed:       completed={} result={:?} halt={:?}",
        resumed.completed, resumed.result, resumed.halt
    );
    println!(
        "[{name}] DIVERGES: {}",
        (continuous.completed, continuous.result.as_str())
            != (resumed.completed, resumed.result.as_str())
    );
}

#[test]
fn scratch_isolate() {
    gate_of("A drop res, keep p", "p = new Promise(function (res) { g = res; }); g = 0; 7");
    gate_of("B never touch res", "p = new Promise(function (res) { g = 1; }); 7");
    gate_of("C proxy over guest fn", "q = new Proxy(function () { return 1; }, {}); 7");
    gate_of(
        "D proxy over res, dropped",
        "p = new Promise(function (res) { q = new Proxy(res, {}); }); q = 0; p = 0; 7",
    );
    gate_of(
        "E proxy over res, retained",
        "p = new Promise(function (res) { q = new Proxy(res, {}); }); p = 0; 7",
    );
    gate_of(
        "F res in a plain global, p dropped",
        "p = new Promise(function (res) { g = res; }); p = 0; 7",
    );
}

#[test]
fn scratch_proxy_holder_probe() {
    probe(
        "proxy target",
        "p = new Promise(function (res) { q = new Proxy(res, {}); }); p = 0; 7",
        "t = typeof q; t",
    );
}
