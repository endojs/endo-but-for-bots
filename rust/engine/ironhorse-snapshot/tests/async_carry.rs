//! Suspended async functions carry their activation and promise capability.
#[path = "common/twin.rs"]
mod carry;
use carry::{compile, twin, Observation};
use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, from_snapshot_bytes, resume_from_store,
    MachineSnapshot,
};
use ironhorse_snapshot::store::HeapStoreCommit;
use ironhorse_snapshot::store::{validate_store, MemoryStore};
use ironhorse_snapshot::Signature;
use ironhorse_vm::Interp;

// Every observation in this family must complete, including the specialized
// blob and intermediate-await paths that do not go through the shared twin.
fn crank(machine: &mut Interp, source: &str) -> Observation {
    let observation = carry::crank(machine, source);
    assert!(observation.0, "{}", observation.1);
    observation
}

fn boot(source: &str) -> Interp {
    let (bytecode, names) = compile(source);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    let outcome = machine.run(&bytecode);
    assert!(outcome.completed, "{:?}", outcome.halt);
    machine
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
        let mut continuous = boot(source);
        let m = boot(source);
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
        let mut observations = vec![settlement];
        if !reject {
            observations.push("next(9);");
        }
        observations.push("result + ':' + trace");
        let expected = twin(source, &observations, &mut MemoryStore::new());
        assert!(expected.iter().all(|observation| observation.0));
        assert_eq!(
            expected.last().unwrap().2,
            if reject {
                "caught:no:finally"
            } else {
                "21:finally"
            }
        );
        assert_eq!(
            crank(&mut continuous, settlement),
            crank(session.machine_mut(), settlement)
        );
        checkpoint_to_store(&mut session, &signature, &mut store).unwrap();
        validate_store(&store, &signature).expect("intermediate await checkpoint validates");
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
            actual.2,
            if reject {
                "caught:no:finally"
            } else {
                "21:finally"
            }
        );
        assert!(actual.0);
        checkpoint_to_store(&mut session, &signature, &mut store).unwrap();
        validate_store(&store, &signature).expect("settled async checkpoint validates");
    }
}

#[test]
fn crafted_async_anchors_capabilities_and_resume_cursors_are_refused() {
    use ironhorse_snapshot::image::{read_machine, write_machine_unchecked};
    use ironhorse_snapshot::store::image_to_batch_unchecked;
    let signature = Signature::new("async-carry");
    let m = boot("var release; var gate = new Promise(r => { release = r; }); async function f() { return await gate; } var result = f();");
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
            from_snapshot_bytes(&write_machine_unchecked(&image), &signature).is_err(),
            "image mutation {kind}"
        );
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(&image, 1, ""))
            .unwrap();
        assert!(
            validate_store(&store, &signature).is_err(),
            "store mutation {kind}"
        );
    }
}

#[test]
fn frozen_intrinsic_surfaces_and_deleted_symbols_survive_restore() {
    let signature = Signature::new("frozen-intrinsics");
    let mut machine = boot("var symbol = Symbol.unscopables; Reflect.ownKeys(Array.prototype); delete Array.prototype[symbol]; Object.freeze(Array.prototype);");
    let bytes = machine.write_snapshot(&signature).unwrap();
    let mut resumed = from_snapshot_bytes(&bytes, &signature).unwrap();
    let probe = "Array.prototype[Symbol.unscopables]; Array.prototype['to' + 'Sorted']; Object.isFrozen(Array.prototype) && Array.prototype[symbol] === undefined";
    assert_eq!(crank(&mut machine, probe), crank(&mut resumed, probe));
    assert_eq!(
        crank(&mut resumed, "Object.isFrozen(Array.prototype)").2,
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
        let mut continuous = boot(source);
        let checkpointed = boot(source);
        let expected = twin(source, &[observation, "result"], &mut MemoryStore::new());
        assert!(expected.iter().all(|observation| observation.0));
        assert_eq!(expected.last().unwrap().2, "6:7");
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
        assert_eq!(crank(&mut continuous, "result").2, "6:7");
    }
}

#[test]
fn unobserved_async_result_survives_pending_await_snapshot() {
    let source = "var release; var gate = new Promise(function (r) { release = r; }); var done; async function f() { done = await gate; } f();";
    let machine = boot(source);
    let signature = Signature::new("unobserved-async-carry");
    let bytes = machine.write_snapshot(&signature).unwrap();
    let mut resumed = from_snapshot_bytes(&bytes, &signature).unwrap();
    assert!(crank(&mut resumed, "release(42); 0").0);
    assert_eq!(crank(&mut resumed, "done").2, "42");
}

#[test]
fn suspended_assignment_targets_survive_blob_and_store_restore() {
    for (setup, body, result) in [
        ("var done;", "done = await gate", "done"),
        ("var done;", "var local; local = await gate; done = local", "done"),
        ("var obj = {value:0}; var key = 'value';", "obj[key] += await gate", "obj.value"),
        ("var obj = [0,0,0]; var key = 2;", "obj[key] += await gate", "obj[2]"),
        ("var obj = {}; var key = Symbol('key'); obj[key] = 0;", "obj[key] += await gate", "obj[key]"),
        // The computed super reference retains both receiver and prototype.
        ("var key = 'value'; var obj = { __proto__: { set value(v) { this.done = v; } }, async f() { super[key] = await gate; } };", "", "obj.done"),
    ] {
        let function = if body.is_empty() {
            "obj.f();".to_string()
        } else {
            format!("async function f() {{ {body}; }} f();")
        };
        let source = format!("var release; var gate = new Promise(r => release = r); {setup} {function}");
        let observations = ["release(42); 0", result];
        let expected = twin(&source, &observations, &mut MemoryStore::new());
        assert_eq!(expected.last().unwrap().2, "42", "{source}");
        let signature = Signature::new("assignment-target-carry");
        let bytes = boot(&source).write_snapshot(&signature).unwrap();
        let mut resumed = from_snapshot_bytes(&bytes, &signature).unwrap();
        for (observation, expected) in observations.into_iter().zip(expected) {
            assert_eq!(crank(&mut resumed, observation), expected, "{source}");
        }
    }
}

#[test]
fn malformed_suspended_assignment_targets_are_refused() {
    use ironhorse_snapshot::image::{read_machine, write_machine_unchecked};
    use ironhorse_snapshot::store::image_to_batch_unchecked;
    use ironhorse_vm::{Kind, Payload, Slot, SlotIndex};
    let signature = Signature::new("assignment-target-refusal");
    let machine = boot("var release; var gate = new Promise(r => release = r); var done; async function f() { done = await gate; } f();");
    let original = read_machine(&machine.write_snapshot(&signature).unwrap(), &signature).unwrap();
    let sentinel = Slot::of(Kind::EnvReference, Payload::Reference(SlotIndex(0)));
    let mut invalid_base = Slot::of(Kind::EnvReference, Payload::Reference(SlotIndex::NULL));
    invalid_base.next = SlotIndex(0);
    let mut invalid_receiver = sentinel;
    invalid_receiver.value = Payload::Reference(SlotIndex(u32::MAX - 1));
    let mut invalid_flags = sentinel;
    invalid_flags.flag = 1;
    let mut invalid_super_base = sentinel;
    invalid_super_base.value = Payload::Reference(SlotIndex(
        original.promise_cluster.async_instances[0].frame.cur_func,
    ));
    invalid_super_base.next = SlotIndex(u32::MAX - 1);
    let mut non_instance_base = invalid_super_base;
    non_instance_base.next = original.slots[0].next;
    assert!(!non_instance_base.next.is_null());
    assert_ne!(
        original.slots[non_instance_base.next.0 as usize].kind,
        Kind::Instance
    );
    for (label, invalid, guest_position) in [
        ("sentinel with base", invalid_base, false),
        ("invalid receiver", invalid_receiver, false),
        ("invalid flags", invalid_flags, false),
        ("invalid super base", invalid_super_base, false),
        ("non-instance super base", non_instance_base, false),
        (
            "bad environment payload",
            Slot::of(Kind::EnvReference, Payload::Integer(0)),
            false,
        ),
        (
            "out of bounds index",
            Slot::of(Kind::At, Payload::At(0, u32::MAX)),
            false,
        ),
        (
            "unknown named key",
            Slot::of(Kind::At, Payload::At(u16::MAX, 0)),
            false,
        ),
        (
            "named key with index",
            Slot::of(Kind::At, Payload::At(1, 1)),
            false,
        ),
        (
            "bad key payload",
            Slot::of(Kind::At, Payload::Integer(0)),
            false,
        ),
        ("environment in result", sentinel, true),
        ("key in result", Slot::of(Kind::At, Payload::At(0, 0)), true),
    ] {
        let mut image = original.clone();
        let frame = &mut image.promise_cluster.async_instances[0].frame;
        if guest_position {
            frame.result = invalid;
        } else {
            let target = frame
                .stack_slice
                .iter_mut()
                .find(|v| v.kind == Kind::EnvReference)
                .unwrap();
            *target = invalid;
        }
        assert!(
            from_snapshot_bytes(&write_machine_unchecked(&image), &signature).is_err(),
            "blob: {label}"
        );
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(&image, 1, ""))
            .unwrap();
        assert!(
            resume_from_store(&store, &signature).is_err(),
            "eager store: {label}"
        );
        assert!(
            ironhorse_snapshot::machine::resume_from_store_lazy(
                std::rc::Rc::new(std::cell::RefCell::new(store)),
                &signature
            )
            .is_err(),
            "lazy store: {label}"
        );
    }
}

#[test]
fn computed_super_preserves_receiver_and_delays_null_base_errors() {
    for (prototype, expected) in [
        ("{ set value(v) { this.done = v; } }", "42"),
        ("null", "TypeError"),
    ] {
        let source = format!("var release; var gate = new Promise(r => release = r); var done; var key = 'value'; var obj = {{ __proto__: {prototype}, async f() {{ try {{ super[key] = await gate; }} catch (e) {{ done = e.name; }} }} }}; obj.f.call(globalThis);");
        let signature = Signature::new("super-global-receiver");
        let bytes = boot(&source).write_snapshot(&signature).unwrap();
        let mut resumed = from_snapshot_bytes(&bytes, &signature).unwrap();
        crank(&mut resumed, "release(42); 0");
        assert_eq!(crank(&mut resumed, "done").2, expected);
        assert_eq!(
            twin(
                &source,
                &["release(42); 0", "done"],
                &mut MemoryStore::new()
            )
            .last()
            .unwrap()
            .2,
            expected
        );
    }
}

#[test]
fn suspended_symbol_assignment_keeps_its_key_through_full_collection() {
    for (function, resume) in [
        (
            "async function f() { obj[Symbol('key')] += await gate; } f();",
            "release(42); 0",
        ),
        (
            "function* f() { obj[Symbol('key')] += yield 0; } var it = f(); it.next();",
            "it.next(42); 0",
        ),
    ] {
        let source = format!(
            "var obj = {{}}; var release; var gate = new Promise(r => release = r); {function}"
        );
        let signature = Signature::new("suspended-symbol-key");
        let mut machine = boot(&source);
        machine.collect_garbage().unwrap();
        let bytes = machine.write_snapshot(&signature).unwrap();
        let mut restored = from_snapshot_bytes(&bytes, &signature).unwrap();
        for machine in [&mut machine, &mut restored] {
            crank(machine, resume);
            assert_eq!(crank(machine, "var keys = Reflect.ownKeys(obj); keys.length + ':' + keys[0].description + ':' + obj[keys[0]]").2, "1:key:NaN");
        }
    }
}
