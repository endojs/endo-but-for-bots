//! TEMPORARY audit probe (coverage review, blind spots): which crank leaves
//! a machine non-quiescent, live vs resumed.
#[path = "common/twin.rs"]
mod carry;
#[allow(dead_code)]
mod common;
use carry::{compile, crank, sig};
use ironhorse_snapshot::machine::{begin_store_session, checkpoint_to_store, resume_from_store};
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_vm::Interp;

const FIRST: &str = "function bfn(a, b, c) { return [this.t, a, b, c].join(); } \
    var bf = bfn.bind({t: 'T'}, 1, 2); function Ctor(a) { this.a = a; } \
    var BC = Ctor.bind(null, 'q'); 1";

fn fresh() -> Interp {
    let (bytecode, names) = compile(FIRST);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    assert!(m.run(&bytecode).completed);
    m
}

#[test]
fn zz_audit_cov_quiescence() {
    let observations = [
        "var bf; bf(3)",
        "var bf; bf.name",
        "var BC; new BC().a",
        "var BC; new BC(); 0",
        "var Ctor; new Ctor(1).a",
        "var bfn; bfn(1)",
        "var bf, BC; bf(3) + ':' + bf.name + ':' + bf.length + ':' + new BC().a",
    ];
    for obs in observations {
        // Live, never stored.
        let mut live = fresh();
        let o = crank(&mut live, obs);
        let live_q = live.is_quiescent();
        // Live inside a store session, then checkpoint.
        let mut store = MemoryStore::new();
        let mut session = begin_store_session(fresh(), &sig(), &mut store)
            .map_err(|(_, e)| e)
            .expect("begin");
        let so = crank(session.machine_mut(), obs);
        let sess_q = session.machine().is_quiescent();
        let sess_ck = checkpoint_to_store(&mut session, &sig(), &mut store);
        drop(session);
        // Resumed from a store seeded by the first crank.
        let mut store2 = MemoryStore::new();
        drop(
            begin_store_session(fresh(), &sig(), &mut store2)
                .map_err(|(_, e)| e)
                .expect("begin2"),
        );
        let mut resumed = resume_from_store(&mut store2, &sig()).expect("resume");
        let ro = crank(resumed.machine_mut(), obs);
        let res_q = resumed.machine().is_quiescent();
        let res_ck = checkpoint_to_store(&mut resumed, &sig(), &mut store2);
        println!(
            "{obs:60} live={:?}/q={live_q} session={:?}/q={sess_q}/ck={:?} resumed={:?}/q={res_q}/ck={:?}",
            (o.0, &o.1, &o.2),
            (so.0, &so.2),
            sess_ck.as_ref().map(|_| ()).map_err(|e| format!("{e:?}")),
            (ro.0, &ro.2),
            res_ck.as_ref().map(|_| ()).map_err(|e| format!("{e:?}")),
        );
    }
}
