//! Suspended async functions carry their activation and promise capability.
use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, from_snapshot_bytes, resume_from_store,
    MachineSnapshot,
};
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::{parse_symbols, Interp};

fn crank(m: &mut Interp, source: &str) -> (String, u64) {
    let (b, s) = ironhorse_compile::compile_atoms(source).unwrap();
    let names = parse_symbols(&s);
    let b = if m.program_symbol_names().is_empty() {
        m.link_intrinsics(&names);
        b
    } else {
        m.relink_crank(&b, &names).unwrap()
    };
    let o = m.run(&b);
    assert!(o.completed, "{:?}", o.halt);
    (o.result, o.computrons)
}

#[test]
fn async_locals_catch_finally_and_multiple_awaits_survive_checkpoints() {
    let signature = Signature::new("async-carry");
    let source = r#"
        var resolve, reject, result = '', trace = '', next;
        var gate = new Promise((r,j) => { resolve = r; reject = j; });
        async function f(x) {
            try { x += await gate; x += await new Promise(r => { next = r; }); return x; }
            catch (e) { return 'caught:' + e; }
            finally { trace += 'finally'; }
        }
        f(7).then(v => { result = v; });
        'pending'
    "#;
    for reject in [false, true] {
        let mut continuous = Interp::new();
        crank(&mut continuous, source);
        let mut m = Interp::new();
        crank(&mut m, source);
        // Both image and incremental-store codecs carry the same state.
        let image = m.write_snapshot(&signature).unwrap();
        let m = from_snapshot_bytes(&image, &signature).unwrap();
        let mut store = MemoryStore::new();
        let session = begin_store_session(m, &signature, &mut store)
            .map_err(|(_, e)| e)
            .unwrap();
        drop(session);
        let mut session = resume_from_store(&store, &signature).unwrap();
        let settlement = if reject {
            "reject('no');"
        } else {
            "resolve(5);"
        };
        assert_eq!(
            crank(&mut continuous, settlement),
            crank(session.machine_mut(), settlement)
        );
        checkpoint_to_store(&mut session, &signature, &mut store).unwrap();
        drop(session);
        let mut session = resume_from_store(&store, &signature).unwrap();
        if !reject {
            assert_eq!(
                crank(&mut continuous, "next(9);"),
                crank(session.machine_mut(), "next(9);")
            );
        }
        let actual = crank(session.machine_mut(), "result + ':' + trace");
        assert_eq!(actual, crank(&mut continuous, "result + ':' + trace"));
        assert_eq!(
            actual.0,
            if reject {
                "caught:no:finally"
            } else {
                "21:finally"
            }
        );
    }
}

#[test]
fn crafted_async_anchors_capabilities_and_resume_cursors_are_refused() {
    use ironhorse_snapshot::image::{read_machine, write_machine};
    use ironhorse_snapshot::store::{image_to_batch, validate_store, HeapStore};
    let signature = Signature::new("async-carry");
    let mut m = Interp::new();
    crank(&mut m, "var release; var gate = new Promise(r => { release = r; }); async function f() { return await gate; } var result = f();");
    let bytes = m.write_snapshot(&signature).unwrap();
    let original = read_machine(&bytes, &signature).unwrap();
    for kind in 0..5 {
        let mut image = original.clone();
        match kind {
            0 => image.promise_cluster.async_instances.clear(),
            1 => image.promise_cluster.async_instances[0].frame.resume_pc = u64::MAX,
            2 => {
                let row = &mut image.promise_cluster.async_instances[0];
                row.reject = row.resolve;
            }
            3 => {
                let reaction = image
                    .promise_cluster
                    .promises
                    .iter_mut()
                    .flat_map(|p| &mut p.reactions)
                    .find(|r| r.kind == 3)
                    .unwrap();
                reaction.a = u32::MAX;
            }
            _ => {
                let row = &mut image.promise_cluster.async_instances[0];
                row.result_promise = u32::MAX;
            }
        }
        assert!(
            from_snapshot_bytes(&write_machine(&image), &signature).is_err(),
            "image mutation {kind}"
        );
        let mut store = MemoryStore::new();
        store.commit(&image_to_batch(&image, 1, "")).unwrap();
        assert!(
            validate_store(&store, &signature).is_err(),
            "store mutation {kind}"
        );
    }
}

#[test]
fn frozen_intrinsic_surfaces_and_deleted_symbols_survive_restore() {
    let signature = Signature::new("frozen-intrinsics");
    let mut machine = Interp::new();
    crank(&mut machine, "var symbol = Symbol.unscopables; Reflect.ownKeys(Array.prototype); delete Array.prototype[symbol]; Object.freeze(Array.prototype);");
    let bytes = machine.write_snapshot(&signature).unwrap();
    let mut resumed = from_snapshot_bytes(&bytes, &signature).unwrap();
    let probe = "Array.prototype[Symbol.unscopables]; Array.prototype['to' + 'Sorted']; Object.isFrozen(Array.prototype) && Array.prototype[symbol] === undefined";
    assert_eq!(crank(&mut machine, probe), crank(&mut resumed, probe));
    assert_eq!(
        crank(&mut resumed, "Object.isFrozen(Array.prototype)").0,
        "true"
    );
}

#[test]
fn closures_sharing_bytecode_resume_after_blob_and_store_checkpoints() {
    let signature = Signature::new("shared-closure-frames");
    for (source, observation) in [
        (
            "var release, result; var gate = new Promise(r => { release = r; }); \
             function factory(x) { return async function () { return x + await gate; }; } \
             var a = factory(1), b = factory(2); \
             Promise.all([a(), b()]).then(values => { result = values.join(':'); });",
            "release(5);",
        ),
        (
            "function factory(x) { return function* () { return x + (yield); }; } \
             var a = factory(1), b = factory(2), ai = a(), bi = b(), result; \
             ai.next(); bi.next();",
            "result = ai.next(5).value + ':' + bi.next(5).value;",
        ),
    ] {
        let mut continuous = Interp::new();
        crank(&mut continuous, source);
        let mut checkpointed = Interp::new();
        crank(&mut checkpointed, source);
        let bytes = checkpointed.write_snapshot(&signature).unwrap();
        let mut blob = from_snapshot_bytes(&bytes, &signature).unwrap();
        let mut store = MemoryStore::new();
        drop(
            begin_store_session(checkpointed, &signature, &mut store)
                .map_err(|(_, error)| error)
                .unwrap(),
        );
        let mut stored = resume_from_store(&store, &signature).unwrap();
        for source in [observation, "result"] {
            let expected = crank(&mut continuous, source);
            assert_eq!(crank(&mut blob, source), expected);
            assert_eq!(crank(stored.machine_mut(), source), expected);
        }
        assert_eq!(crank(&mut continuous, "result").0, "6:7");
    }
}
