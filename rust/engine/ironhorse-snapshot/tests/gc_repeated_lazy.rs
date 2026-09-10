//! Alternate collectors across cold resumes while preserving mixed live state.
use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, partial_collect, resume_from_store,
    resume_from_store_lazy, MachineSnapshot,
};
use ironhorse_snapshot::{store::MemoryStore, Signature};
use ironhorse_vm::{
    value::{CHUNK_EXTENT_BYTES, SLOTS_PER_PAGE},
    Interp, RunOutcome,
};
use std::{cell::RefCell, rc::Rc};

#[path = "common/compile.rs"]
mod compiler;

fn run(m: &mut Interp, text: &str) -> RunOutcome {
    let (code, names) = compiler::compile(text);
    let code = m.relink_crank(&code, &names).unwrap();
    let out = m.run(&code);
    assert!(out.completed, "{text}: {:?}", out.halt);
    out
}

fn assert_same_crank(machine: &mut Interp, baseline: &mut Interp, source: &str) {
    let expected = run(baseline, source);
    let actual = run(machine, source);
    assert_eq!(actual.result, expected.result);
    // Compare the complete fixed-point accumulator, including fractional carry.
    assert_eq!(actual.meter_raw, expected.meter_raw);
}

#[test]
fn mixed_live_state_survives_alternating_collectors_and_lazy_resume() {
    let sig = Signature::new("gc-repeated-lazy");
    let mut baseline = Interp::new();
    let setup = r#"
        var keep = []; var map = new Map(); var weak = new WeakMap();
        var buf = new Uint8Array(70000);
        var f = (function(n) { return function() { return ++n; }; })(0);
        var gen = (function*() { for (var i = 0; i < 100; i++) yield i; })();
        var rr; var pp = new Promise(r => rr = r); var result = 0;
        pp.then(v => result = v);
        for (var i = 0; i < 100; i++) {
            var x = {v: i}; keep.push(x); map.set(x, 'string-' + i);
            weak.set(x, {w: i}); buf[i] = i;
        }
        0
    "#;
    run(&mut baseline, setup);
    let mut m = Interp::new();
    run(&mut m, setup);
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    let mut session = begin_store_session(m, &sig, &mut *store.borrow_mut())
        .map_err(|(_, e)| e)
        .unwrap();
    let mut partial_freed = 0;
    let mut full_freed = 0;
    for round in 0..12 {
        let churn = r#"
            for (var j = 0; j < 2000; j++) { var dead = {v: 'garbage-' + j}; }
            dead = null;
            JSON.stringify([f(), gen.next().value, keep[50].v,
                map.get(keep[51]), weak.get(keep[52]).w, buf[53], result])
        "#;
        assert_same_crank(session.machine_mut(), &mut baseline, churn);
        checkpoint_to_store(&mut session, &sig, &mut *store.borrow_mut()).unwrap();
        if round % 2 == 0 {
            partial_freed += partial_collect(&mut session, &*store.borrow()).unwrap();
        } else {
            full_freed += session.machine_mut().collect_garbage().slots_reclaimed;
        }
        checkpoint_to_store(&mut session, &sig, &mut *store.borrow_mut()).unwrap();
        for p in 0..session.machine().slots.capacity().div_ceil(SLOTS_PER_PAGE) {
            let _ = session.machine().slots.evict_page(p);
        }
        for e in 0..session
            .machine()
            .chunks
            .byte_size()
            .div_ceil(CHUNK_EXTENT_BYTES as usize)
        {
            let _ = session.machine().chunks.evict_extent(e as u32);
        }
        if round > 0 {
            assert_eq!(session.machine().slots.resident_page_count(), 0);
            assert_eq!(session.machine().chunks.resident_extent_count(), 0);
        }
        // Reading the evicted machine checks its advanced backing after GC.
        let bytes = session.machine().write_snapshot(&sig).unwrap();
        session = resume_from_store_lazy(store.clone(), &sig).unwrap();
        // Use a separate eager restore for byte parity: the lazy session stays
        // cold until the next crank and must fault its own working set.
        assert_eq!(
            resume_from_store(&*store.borrow(), &sig)
                .unwrap()
                .machine()
                .write_snapshot(&sig)
                .unwrap(),
            bytes,
            "round {round}"
        );
    }
    assert!(partial_freed > 0, "fixture must exercise partial sweeping");
    assert!(full_freed > 0, "fixture must exercise full sweeping");
    assert_same_crank(session.machine_mut(), &mut baseline, "rr(99); 0");
    assert_same_crank(session.machine_mut(), &mut baseline, "result");
    assert_eq!(run(session.machine_mut(), "result").result, "99");
}

#[test]
fn lazy_collection_relocates_suspended_async_generator_handlers() {
    let sig = Signature::new("gc-async-generator-handlers");
    let mut baseline = Interp::new();
    let mut machine = Interp::new();
    // Allocate a dead earlier segment so the saved handler's segment must move.
    let discarded = "var discarded = function() {}; discarded = null; 0";
    assert_same_crank(&mut machine, &mut baseline, discarded);
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    let initial = begin_store_session(machine, &sig, &mut *store.borrow_mut())
        .map_err(|(_, error)| error)
        .unwrap();
    drop(initial);
    let mut session = resume_from_store_lazy(store.clone(), &sig).unwrap();
    let suspend = r#"
        var trace = '';
        var iterator = (async function*() {
            try { yield 'ready'; }
            catch (e) { trace += 'catch:' + e + ';'; yield 'handled'; }
            finally { trace += 'finally;'; }
        })();
        iterator.next().then(r => trace += 'start:' + r.value + ';');
        0
    "#;
    assert_same_crank(session.machine_mut(), &mut baseline, suspend);
    assert_eq!(session.machine().retained_code_segment_count(), 2);
    session.machine_mut().collect_garbage();
    assert_eq!(session.machine().retained_code_segment_count(), 1);
    session.machine_mut().collect_garbage();
    assert_same_crank(
        session.machine_mut(),
        &mut baseline,
        "iterator.throw('boom').then(r => trace += 'caught:' + r.value + ';'); 0",
    );
    assert_same_crank(
        session.machine_mut(),
        &mut baseline,
        "iterator.next().then(r => trace += 'done:' + r.done + ';'); 0",
    );
    // Live async generators deliberately cannot persist yet. After exercising
    // the saved catch/finally targets, drop the completed generator and commit.
    assert_same_crank(session.machine_mut(), &mut baseline, "iterator = null; 0");
    session.machine_mut().collect_garbage();
    checkpoint_to_store(&mut session, &sig, &mut *store.borrow_mut()).unwrap();
    let mut restored = resume_from_store_lazy(store, &sig).unwrap();
    assert_same_crank(restored.machine_mut(), &mut baseline, "trace");
    assert_eq!(
        run(restored.machine_mut(), "trace").result,
        "start:ready;catch:boom;caught:handled;finally;done:true;"
    );
}
