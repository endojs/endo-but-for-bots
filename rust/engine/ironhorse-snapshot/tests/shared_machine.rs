//! One Realm and multiple environments survive the production container path.
use ironhorse_snapshot::{
    machine::{from_snapshot_bytes, MachineSnapshot},
    Signature,
};
use ironhorse_vm::{Compartment, EnvironmentId, EnvironmentPolicy, Machine, MachineRestorePolicy};
use std::collections::BTreeMap;

fn eval(c: &Compartment, source: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let outcome = c.evaluate_with_symbols(&code, &symbols);
    assert!(outcome.completed, "{source}: {:?}", outcome.halt);
    outcome.result
}
fn roundtrip(m: &Machine) -> Machine {
    let signature = Signature::new("shared-machine-tests");
    let bytes = m
        .with_persistence(|i| i.write_snapshot(&signature))
        .unwrap()
        .unwrap();
    let i = from_snapshot_bytes(&bytes, &signature).unwrap();
    let environments = i
        .shared_environment_ids()
        .into_iter()
        .map(|id| {
            (
                EnvironmentId(id),
                EnvironmentPolicy {
                    intrinsic_permit: None,
                    source_compiler: None,
                    name: None,
                    has_resolve_hook: false,
                    has_import_hook: false,
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    Machine::from_restored_interpreter(
        i,
        MachineRestorePolicy {
            host_callables: Default::default(),
            environments,
            meter_host: None,
        },
    )
    .unwrap()
}

#[test]
fn shared_objects_and_cross_compartment_closures_roundtrip() {
    let m = Machine::new();
    let a = m.new_compartment();
    let mut b = m.new_compartment();
    eval(&a, "var answer = 42; var object = {value: 1}; function f() { return answer + object.value; } 0");
    b.define_global_value("f", &a.global_value("f").unwrap())
        .unwrap();
    b.define_global_value("object", &a.global_value("object").unwrap())
        .unwrap();
    assert_eq!(eval(&b, "var answer = 99; object.value = 2; f()"), "44");
    let aid = a.snapshot_id().unwrap();
    let bid = b.snapshot_id().unwrap();
    let restored = roundtrip(&m);
    let ra = restored.claim_compartment(aid).unwrap();
    let rb = restored.claim_compartment(bid).unwrap();
    assert_eq!(eval(&rb, "object.value = 3; f()"), "45");
    assert_eq!(eval(&ra, "object.value"), "3");
    assert_eq!(
        ra.global_object_identity("Object"),
        rb.global_object_identity("Object")
    );
}

#[test]
fn queued_jobs_survive_source_drop_and_do_not_run_during_snapshot() {
    let m = Machine::new();
    let a = m.new_compartment();
    let mut b = m.new_compartment();
    eval(&a, "var log = []; var answer = 42; var p = Promise.resolve(); p.then(() => log.push(answer)); 0");
    b.define_global_value("log", &a.global_value("log").unwrap())
        .unwrap();
    eval(&b, "var answer = 99; log.length");
    let bid = b.snapshot_id().unwrap();
    drop(a);
    m.collect().unwrap();
    let restored = roundtrip(&m);
    let rb = restored.claim_compartment(bid).unwrap();
    assert_eq!(eval(&rb, "log.length"), "0");
    restored.release_unclaimed_roots().unwrap();
    restored.collect().unwrap();
    let outcome = restored.run_promise_jobs();
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(eval(&rb, "log.join(',')"), "42");
}

#[test]
fn suspended_work_and_combinator_jobs_keep_their_defining_globals() {
    let m = Machine::new();
    let a = m.new_compartment();
    let mut b = m.new_compartment();
    eval(&a, "var answer = 42, log = [], settle; var gate = new Promise(r => settle = r); async function work() { log.push(await gate + answer); } work(); function* gen() { yield answer; return answer + 1; } var g = gen(); g.next(); Promise.all([1,2]).then(xs => log.push(xs.join(':'))); 0");
    for name in ["log", "settle", "g"] {
        b.define_global_value(name, &a.global_value(name).unwrap())
            .unwrap();
    }
    eval(&b, "var answer = 99; 0");
    let bid = b.snapshot_id().unwrap();
    // The await frame remains suspended, while both Promise.all reactions are queued.
    let restored = roundtrip(&m);
    let rb = restored.claim_compartment(bid).unwrap();
    assert_eq!(eval(&rb, "g.next().value"), "43");
    eval(&rb, "settle(1); 0");
    let out = restored.run_promise_jobs();
    assert!(out.completed, "{:?}", out.halt);
    assert_eq!(eval(&rb, "log.join(',')"), "43,1:2");
}

#[test]
fn queued_async_resume_and_thenable_jobs_roundtrip() {
    for source in [
        "var log = []; async function f() { log.push(await 42); } f(); 0",
        "var log = []; Promise.resolve({then(r) { r(42); }}).then(x => log.push(x)); 0",
    ] {
        let m = Machine::new();
        let a = m.new_compartment();
        eval(&a, source);
        let id = a.snapshot_id().unwrap();
        let restored = roundtrip(&m);
        let a = restored.claim_compartment(id).unwrap();
        let out = restored.run_promise_jobs();
        assert!(out.completed, "{:?}", out.halt);
        assert_eq!(eval(&a, "log.join(',')"), "42");
    }
}

#[test]
fn host_roots_reacquire_after_source_drop_and_collection() {
    let m = Machine::new();
    let a = m.new_compartment();
    let b = m.new_compartment();
    eval(&a, "var answer = 42; var f = () => answer; 0");
    eval(&b, "0");
    let root = a.global_value("f").unwrap();
    let root_id = root.snapshot_id();
    let bid = b.snapshot_id().unwrap();
    drop(a);
    m.collect().unwrap();
    let restored = roundtrip(&m);
    let mut b = restored.claim_compartment(bid).unwrap();
    let f = restored.claim_rooted_value(root_id).unwrap();
    restored.release_unclaimed_roots().unwrap();
    restored.collect().unwrap();
    b.define_global_value("f", &f).unwrap();
    assert_eq!(eval(&b, "f()"), "42");
    assert!(b.define_global_value("foreign", &root).is_err());
}

fn empty_policy(ids: &[EnvironmentId]) -> MachineRestorePolicy {
    MachineRestorePolicy {
        host_callables: Default::default(),
        environments: ids
            .iter()
            .map(|id| {
                (
                    *id,
                    EnvironmentPolicy {
                        intrinsic_permit: None,
                        source_compiler: None,
                        name: None,
                        has_resolve_hook: false,
                        has_import_hook: false,
                    },
                )
            })
            .collect(),
        meter_host: None,
    }
}

#[test]
fn eager_lazy_checkpoint_and_rewind_keep_one_owner_graph_per_resume() {
    use ironhorse_snapshot::machine::{
        begin_shared_store_session, resume_shared_from_store, resume_shared_from_store_lazy,
    };
    use ironhorse_snapshot::store::{validate_store, MemoryStore};
    use std::{cell::RefCell, rc::Rc};
    for lazy in [false, true] {
        let signature = Signature::new("shared-store");
        let store = Rc::new(RefCell::new(MemoryStore::new()));
        let m = Machine::new();
        let a = m.new_compartment();
        let mut b = m.new_compartment();
        eval(&a, "var answer = 42; var log = []; var f = () => answer; Promise.resolve(1).then(x => log.push(x + answer)); 0");
        for name in ["f", "log"] {
            b.define_global_value(name, &a.global_value(name).unwrap())
                .unwrap();
        }
        eval(&b, "var answer = 99; 0");
        let bid = b.snapshot_id().unwrap();
        let ids = m
            .with_persistence(|i| {
                i.shared_environment_ids()
                    .into_iter()
                    .map(EnvironmentId)
                    .collect::<Vec<_>>()
            })
            .unwrap();
        let mut continuous = begin_shared_store_session(m, &signature, &mut *store.borrow_mut(), 0)
            .ok()
            .unwrap();
        // No allocation or snapshot-driven pump changes the live handles' identity.
        let original = b.global_object_identity("log");
        continuous
            .checkpoint(&signature, &mut *store.borrow_mut())
            .unwrap();
        assert_eq!(original, b.global_object_identity("log"));
        let mut restored = if lazy {
            resume_shared_from_store_lazy(store.clone(), &signature, empty_policy(&ids)).unwrap()
        } else {
            resume_shared_from_store(&*store.borrow(), &signature, empty_policy(&ids)).unwrap()
        };
        let rb = restored.machine().claim_compartment(bid).unwrap();
        assert_eq!(eval(&rb, "f()"), "42");
        let out = restored.machine().run_promise_jobs();
        assert!(out.completed, "{:?}", out.halt);
        assert_eq!(eval(&rb, "log.join(',')"), "43");
        restored
            .checkpoint(&signature, &mut *store.borrow_mut())
            .unwrap();
        restored.full_collect(&*store.borrow()).unwrap();
        restored
            .checkpoint(&signature, &mut *store.borrow_mut())
            .unwrap();
        validate_store(&*store.borrow(), &signature).unwrap();
        let retained = rb.global_value("f").unwrap();
        eval(&rb, "log.push(100); 0");
        // Rewind adopts a fresh Machine after successful restore. Old handles cannot
        // silently target its reused arena addresses.
        let rewound =
            resume_shared_from_store(&*store.borrow(), &signature, empty_policy(&ids)).unwrap();
        let mut new_b = rewound.machine().claim_compartment(bid).unwrap();
        assert_eq!(eval(&new_b, "log.join(',')"), "43");
        assert!(new_b.define_global_value("old", &retained).is_err());
        assert_eq!(eval(&rb, "log.join(',')"), "43,100");
    }
}

struct Compiler;
impl ironhorse_vm::SourceCompiler for Compiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
        budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
        ironhorse_compile::compile_atoms_budgeted_with_limit(
            source,
            ironhorse_compile::Goal::Eval,
            strict,
            budget,
            charge,
        )
        .map(|c| ironhorse_vm::CompiledSource {
            bytecode: c.bytecode,
            symbols: c.symbols,
            parse_meter_raw: c.parse_meter_raw,
            parse_computrons: c.parse_computrons,
        })
        .map_err(|e| ironhorse_vm::SourceCompileError::Syntax(format!("{e:?}")))
    }
}

#[test]
fn evaluators_bound_wrappers_and_accessors_restore_before_their_users() {
    let m = Machine::new();
    let mut a = m.new_compartment();
    let mut b = m.new_compartment();
    a.set_source_compiler(std::rc::Rc::new(Compiler));
    eval(&a, "var answer = 42; var bound = eval.bind(null); var construct = Function.bind(null); var obj = {}; Object.defineProperty(obj, 'x', {get: eval}); 0");
    for name in ["bound", "construct", "obj"] {
        b.define_global_value(name, &a.global_value(name).unwrap())
            .unwrap();
    }
    eval(&b, "var answer = 99; 0");
    let bid = b.snapshot_id().unwrap();
    let signature = Signature::new("shared-evaluators");
    let bytes = m.write_snapshot(&signature).unwrap();
    let interp = from_snapshot_bytes(&bytes, &signature).unwrap();
    let ids: Vec<_> = interp
        .shared_environment_ids()
        .into_iter()
        .map(EnvironmentId)
        .collect();
    assert!(
        Machine::from_restored_interpreter(interp, empty_policy(&ids)).is_err(),
        "missing required compiler refuses admission"
    );
    let mut policy = empty_policy(&ids);
    for environment in policy.environments.values_mut() {
        environment.source_compiler = Some(std::rc::Rc::new(Compiler));
    }
    let restored = Machine::from_restored_interpreter(
        from_snapshot_bytes(&bytes, &signature).unwrap(),
        policy,
    )
    .unwrap();
    let b = restored.claim_compartment(bid).unwrap();
    assert_eq!(eval(&b, "bound('answer')"), "42");
    assert_eq!(eval(&b, "construct('return answer')()"), "42");
    assert_eq!(eval(&b, "typeof obj.x"), "undefined");
}

#[test]
fn malformed_contexts_and_cyclic_queued_callables_refuse_restore() {
    use ironhorse_vm::{Kind, Payload, Slot, SlotIndex};
    let m = Machine::new();
    let a = m.new_compartment();
    eval(&a, "var answer = 42; var f = () => answer; var proxy = new Proxy(f, {}); Promise.resolve(1).then(proxy); 0");
    let signature = Signature::new("shared-refusals");
    let image = m.snapshot_image(&signature).unwrap().into_image();
    for mutation in 0..7 {
        let mut bad = image.clone();
        let state = bad.function_state.shared.as_mut().unwrap();
        match mutation {
            0 => state.current_global = u32::MAX,
            1 => state.function_environments.clear(),
            2 => state.evaluators[0].kind = 255,
            3 => state.roots.push(u32::MAX),
            4 => state.jobs[0].reaction.a = 1,
            5 => {
                let proxy = &mut bad.proxy_state.proxies[0];
                proxy.target = proxy.owner;
                state.jobs[0].reaction.resolve =
                    Slot::of(Kind::Reference, Payload::Reference(SlotIndex(proxy.owner)));
            }
            6 => {
                let root = state.intrinsic_roots[0];
                bad.slots[root as usize].flag &= !16;
            }
            _ => unreachable!(),
        }
        assert_restore_refuses(bad, signature.clone());
    }
}

#[test]
fn module_only_compartments_preserve_cells_and_evaluation_status() {
    use ironhorse_vm::{
        BodyOp, CompartmentOptions, ExportEntry, ModuleGraph, ModuleRecord, ModuleValue, Slot,
    };
    let mut modules = ModuleGraph::new();
    modules.insert(
        ModuleRecord::new("counter")
            .with_export(ExportEntry::Local {
                export_name: "x".into(),
                local_name: "x".into(),
            })
            .with_body(BodyOp::InitLocal {
                local_name: "x".into(),
                value: Slot::integer(42),
            }),
    );
    let m = Machine::new();
    let mut c = m.compartment(CompartmentOptions {
        modules,
        ..Default::default()
    });
    let module = c.import_static("counter").unwrap();
    let id = c
        .snapshot_id()
        .expect("module-only compartment has a persisted environment");
    let restored = roundtrip(&m);
    let mut c = restored.claim_compartment(id).unwrap();
    assert_eq!(c.import_static("counter").unwrap(), module);
    let modules = c.module_map();
    assert_eq!(
        modules.namespace(module).get("x").unwrap(),
        Some(ModuleValue::Value(Slot::integer(42)))
    );
}

#[test]
fn restored_prospective_permit_applies_to_computed_names_and_preserves_deletions() {
    use ironhorse_vm::CompartmentOptions;
    for delete in [false, true] {
        let m = Machine::new();
        let a = m.compartment(CompartmentOptions {
            intrinsic_permit: Some(vec![]),
            ..Default::default()
        });
        let mut b = m.new_compartment();
        eval(&a, "var foreign = globalThis; 0");
        if delete {
            b.define_global_value("foreign", &a.global_value("foreign").unwrap())
                .unwrap();
            eval(
                &b,
                "foreign['Da' + 'te'] = 42; delete foreign['Da' + 'te']; 0",
            );
        }
        let id = a.snapshot_id().unwrap();
        let restored = roundtrip(&m); // Explicitly reattach an unrestricted prospective permit.
        let a = restored.claim_compartment(id).unwrap();
        assert_eq!(
            eval(&a, "typeof globalThis['Da' + 'te']"),
            if delete { "undefined" } else { "function" }
        );
        assert_eq!(
            eval(&a, "typeof Date"),
            if delete { "undefined" } else { "function" }
        );
    }
}

#[test]
fn pending_endowments_refuse_snapshot_without_silently_losing_configuration() {
    let m = Machine::new();
    let mut c = m.new_compartment();
    c.define_global("x", ironhorse_vm::Slot::integer(42));
    assert!(matches!(
        m.write_snapshot(&Signature::new("pending")),
        Err(_)
    ));
    assert_eq!(eval(&c, "x"), "42");
    let id = c.snapshot_id().unwrap();
    let restored = roundtrip(&m);
    assert_eq!(eval(&restored.claim_compartment(id).unwrap(), "x"), "42");
}

#[test]
fn rejection_reports_remain_isolated_when_settled_from_a_reporting_compartment() {
    let m = Machine::new();
    let a = m.new_compartment();
    let mut b = m.new_compartment();
    eval(&a, "var reject; new Promise((r,j) => reject = j); 0");
    b.define_global_value("rejectA", &a.global_value("reject").unwrap())
        .unwrap();
    eval(&b, "Promise.reject('B'); 0");
    assert!(m.run_promise_jobs().completed);
    eval(&b, "rejectA('A'); 0");
    let restored = roundtrip(&m);
    assert!(restored.run_promise_jobs().completed);
    assert_eq!(restored.unhandled_rejections().unwrap().len(), 2);
    let again = roundtrip(&restored);
    assert_eq!(again.unhandled_rejections().unwrap().len(), 2);
}

#[test]
fn object_identities_reacquire_and_unclaimed_handles_do_not_pin_forever() {
    let m = Machine::new();
    let a = m.new_compartment();
    eval(&a, "var obj = {}; 0");
    let aid = a.snapshot_id().unwrap();
    let identity = a.global_object_identity("obj").unwrap();
    let root = identity.snapshot_id();
    let restored = roundtrip(&m);
    let a = restored.claim_compartment(aid).unwrap();
    let identity = restored.claim_object_identity(root).unwrap();
    assert_eq!(a.global_object_identity("obj").unwrap(), identity);
    drop(a);
    drop(identity);
    restored.release_unclaimed_roots().unwrap();
    restored.collect().unwrap();
    let ids = restored
        .with_persistence(|i| i.shared_environment_ids())
        .unwrap();
    assert!(!ids.contains(&aid.0));
}

#[test]
fn snapshot_does_not_reapply_stale_compiler_configuration() {
    use std::{cell::Cell, rc::Rc};
    struct Counted(Rc<Cell<usize>>);
    impl ironhorse_vm::SourceCompiler for Counted {
        fn compile_source(
            &self,
            source: &str,
            strict: bool,
            budget: u64,
            charge: &mut dyn FnMut(u64) -> bool,
        ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
            self.0.set(self.0.get() + 1);
            Compiler.compile_source(source, strict, budget, charge)
        }
    }
    let m = Machine::new();
    let mut a = m.start_compartment();
    let mut b = m.start_compartment();
    let ca = Rc::new(Cell::new(0));
    let cb = Rc::new(Cell::new(0));
    a.set_source_compiler(Rc::new(Counted(ca.clone())));
    b.set_source_compiler(Rc::new(Counted(cb.clone())));
    eval(&b, "0");
    eval(&a, "0");
    m.write_snapshot(&Signature::new("compiler-policy"))
        .unwrap();
    let c = m.start_compartment();
    assert_eq!(eval(&c, "Function('return 42')()"), "42");
    assert_eq!(ca.get(), 1);
    assert_eq!(cb.get(), 0);
}

#[test]
fn queued_continuation_retains_exact_meter_and_observations() {
    let m = Machine::new();
    let c = m.new_compartment();
    eval(
        &c,
        "var log = []; Promise.all([1,2,3]).then(xs => log.push(xs.reduce((a,b)=>a+b,0))); 0",
    );
    let id = c.snapshot_id().unwrap();
    let before = m.with_persistence(|i| i.meter_state()).unwrap();
    let restored = roundtrip(&m);
    assert_eq!(m.with_persistence(|i| i.meter_state()).unwrap(), before);
    let a = m.run_promise_jobs();
    let b = restored.run_promise_jobs();
    assert!(a.completed && b.completed);
    assert_eq!(a.meter_raw, b.meter_raw);
    assert_eq!(
        m.with_persistence(|i| i.meter_state()).unwrap(),
        restored.with_persistence(|i| i.meter_state()).unwrap()
    );
    let r = restored.claim_compartment(id).unwrap();
    assert_eq!(eval(&c, "log.join(',')"), eval(&r, "log.join(',')"));
}

#[test]
fn compartment_and_its_global_identity_can_be_claimed_in_either_order() {
    for identity_first in [false, true] {
        let m = Machine::new();
        let a = m.new_compartment();
        eval(&a, "0");
        let aid = a.snapshot_id().unwrap();
        let identity = a.global_object_identity("globalThis").unwrap();
        let rid = identity.snapshot_id();
        let restored = roundtrip(&m);
        let (a, identity) = if identity_first {
            let identity = restored.claim_object_identity(rid).unwrap();
            (restored.claim_compartment(aid).unwrap(), identity)
        } else {
            let a = restored.claim_compartment(aid).unwrap();
            (a, restored.claim_object_identity(rid).unwrap())
        };
        assert_eq!(a.global_object_identity("globalThis").unwrap(), identity);
    }
}

#[test]
fn unclaimed_environment_and_export_ownership_are_independent() {
    for identity_first in [false, true] {
        let m = Machine::new();
        let a = m.new_compartment();
        eval(&a, "0");
        let aid = a.snapshot_id().unwrap();
        let identity = a.global_object_identity("globalThis").unwrap();
        let rid = identity.snapshot_id();
        let restored = roundtrip(&m);
        if identity_first {
            drop(restored.claim_object_identity(rid).unwrap());
        } else {
            drop(restored.claim_compartment(aid).unwrap());
        }
        restored.collect().unwrap();
        if identity_first {
            let a = restored.claim_compartment(aid).unwrap();
            assert_eq!(eval(&a, "42"), "42");
        } else {
            restored.claim_object_identity(rid).unwrap();
        }
    }
}

fn assert_restore_refuses(image: ironhorse_snapshot::MachineImage, signature: Signature) {
    let bytes = ironhorse_snapshot::write_machine_unchecked(&image);
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let refused = from_snapshot_bytes(&bytes, &signature).is_err();
        send.send(refused).unwrap();
    });
    assert!(receive
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("malformed restore must terminate"));
}

#[test]
fn contextual_rows_reject_inconsistent_reports_modules_and_thenable_capabilities() {
    use ironhorse_vm::{BodyOp, CompartmentOptions, ExportEntry, ModuleGraph, ModuleRecord, Slot};
    let signature = Signature::new("contextual-refusals");
    let m = Machine::new();
    let a = m.new_compartment();
    let b = m.new_compartment();
    eval(&a, "Promise.reject('A'); 0");
    eval(&b, "0");
    m.run_promise_jobs();
    let mut bad = m.snapshot_image(&signature).unwrap().into_image();
    let shared = bad.function_state.shared.as_mut().unwrap();
    let report = shared
        .environments
        .iter_mut()
        .find_map(|e| e.unhandled_rejection.take())
        .unwrap();
    shared
        .environments
        .iter_mut()
        .find(|e| e.global == b.snapshot_id().unwrap().0)
        .unwrap()
        .unhandled_rejection = Some(report);
    assert_restore_refuses(bad, signature.clone());

    let mut modules = ModuleGraph::new();
    modules.insert(
        ModuleRecord::new("m")
            .with_export(ExportEntry::Local {
                export_name: "x".into(),
                local_name: "x".into(),
            })
            .with_body(BodyOp::InitLocal {
                local_name: "x".into(),
                value: Slot::integer(42),
            }),
    );
    let m = Machine::new();
    let mut a = m.compartment(CompartmentOptions {
        modules,
        ..Default::default()
    });
    a.import_static("m").unwrap();
    let mut bad = m.snapshot_image(&signature).unwrap().into_image();
    bad.function_state
        .shared
        .as_mut()
        .unwrap()
        .environments
        .iter_mut()
        .find(|e| !e.modules.modules.is_empty())
        .unwrap()
        .modules
        .modules[0]
        .environment
        .clear();
    assert_restore_refuses(bad, signature.clone());

    let m = Machine::new();
    let a = m.new_compartment();
    eval(
        &a,
        "Promise.resolve({then(r){r(1)}}); Promise.resolve({then(r){r(2)}}); 0",
    );
    let image = m.snapshot_image(&signature).unwrap().into_image();
    for foreign in [false, true] {
        let mut bad = image.clone();
        let jobs = &mut bad.function_state.shared.as_mut().unwrap().jobs;
        jobs[0].reaction.reject = if foreign {
            jobs[1].reaction.reject
        } else {
            jobs[0].reaction.resolve
        };
        assert_restore_refuses(bad, signature.clone());
    }
    let mut bad = image;
    let shared = bad.function_state.shared.as_mut().unwrap();
    let guest = a.snapshot_id().unwrap().0;
    shared
        .function_environments
        .iter_mut()
        .find(|(owner, _)| *owner < shared.evaluators[0].owner)
        .unwrap()
        .1 = guest;
    assert_restore_refuses(bad, signature);
}

#[test]
fn dropping_reacquired_identity_does_not_export_a_compartment_lease() {
    let m = Machine::new();
    let a = m.new_compartment();
    eval(&a, "0");
    let aid = a.snapshot_id().unwrap();
    let identity = a.global_object_identity("globalThis").unwrap();
    let rid = identity.snapshot_id();
    let restored = roundtrip(&m);
    let _a = restored.claim_compartment(aid).unwrap();
    drop(restored.claim_object_identity(rid).unwrap());
    let image = restored
        .snapshot_image(&Signature::new("recapture-roots"))
        .unwrap()
        .into_image();
    assert!(!image.function_state.shared.unwrap().roots.contains(&rid.0));
}

#[test]
fn nested_a_b_a_calls_restore_the_defining_environment_at_each_return() {
    let m = Machine::new();
    let mut a = m.new_compartment();
    let mut b = m.new_compartment();
    eval(
        &a,
        "var marker = 1; function fa(recurse) { return recurse ? fb() + marker : marker; } 0",
    );
    b.define_global_value("fa", &a.global_value("fa").unwrap())
        .unwrap();
    eval(
        &b,
        "var marker = 10; function fb() { return fa(false) + marker; } 0",
    );
    a.define_global_value("fb", &b.global_value("fb").unwrap())
        .unwrap();
    assert_eq!(eval(&a, "fa(true)"), "12");
    let id = a.snapshot_id().unwrap();
    let restored = roundtrip(&m);
    assert_eq!(
        eval(&restored.claim_compartment(id).unwrap(), "fa(true)"),
        "12"
    );
}

#[test]
fn incomplete_crank_refuses_snapshot() {
    let m = Machine::new();
    let a = m.new_compartment();
    let (code, symbols) = ironhorse_compile::compile_atoms("throw 42").unwrap();
    assert!(!a.evaluate_with_symbols(&code, &symbols).completed);
    assert!(m.write_snapshot(&Signature::new("incomplete")).is_err());
}

#[test]
fn shared_admission_reports_specific_schema_and_queue_errors() {
    use ironhorse_snapshot::SnapshotError;
    let m = Machine::new();
    let a = m.new_compartment();
    eval(&a, "Promise.all([1,2]); 0");
    let signature = Signature::new("specific-refusals");
    let image = m.snapshot_image(&signature).unwrap().into_image();
    let mut bad = image.clone();
    bad.version.format_version = 20;
    assert!(matches!(
        from_snapshot_bytes(
            &ironhorse_snapshot::write_machine_unchecked(&bad),
            &signature
        ),
        Err(SnapshotError::Corrupt("shared machine requires format 21"))
    ));
    let mut bad = image.clone();
    bad.function_state.shared.as_mut().unwrap().evaluators[0].kind = 255;
    assert!(matches!(
        from_snapshot_bytes(
            &ironhorse_snapshot::write_machine_unchecked(&bad),
            &signature
        ),
        Err(SnapshotError::Corrupt("invalid shared machine state"))
    ));
    let mut bad = image.clone();
    bad.function_state.shared.as_mut().unwrap().jobs[0]
        .reaction
        .a = u32::MAX;
    assert!(matches!(
        from_snapshot_bytes(
            &ironhorse_snapshot::write_machine_unchecked(&bad),
            &signature
        ),
        Err(SnapshotError::Corrupt(
            "promise cluster: combinator index outside table"
        ))
    ));
    let mut bad = image;
    let jobs = &mut bad.function_state.shared.as_mut().unwrap().jobs;
    jobs[1].reaction.b = jobs[0].reaction.b;
    assert!(matches!(
        from_snapshot_bytes(
            &ironhorse_snapshot::write_machine_unchecked(&bad),
            &signature
        ),
        Err(SnapshotError::Corrupt(
            "promise cluster: duplicate combinator element"
        ))
    ));
}

struct PersistedHost;
impl ironhorse_vm::HostCallable for PersistedHost {
    fn call<'s>(&self, cx: &mut ironhorse_vm::HostCallContext<'s>) -> ironhorse_vm::HostResult<'s> {
        cx.charge(12345)?;
        let function = cx.capture(0).unwrap();
        let this = cx.receiver();
        let argument = cx.argument(0);
        cx.call(function, this, &[argument])
    }
}
fn host_id() -> ironhorse_vm::HostCallableId {
    ironhorse_vm::HostCallableId {
        name: "persisted.test".into(),
        abi: 7,
    }
}
fn host_policy(ids: &[EnvironmentId]) -> MachineRestorePolicy {
    let mut policy = empty_policy(ids);
    policy
        .host_callables
        .insert(host_id(), std::rc::Rc::new(PersistedHost));
    policy
}
fn host_fixture() -> (Machine, Compartment, Vec<EnvironmentId>) {
    let m = Machine::new();
    let a = m.new_compartment();
    let mut b = m.new_compartment();
    eval(
        &a,
        "var base = 40; function captured(x) { return base + x; } 0",
    );
    m.register_host_callable(host_id(), std::rc::Rc::new(PersistedHost))
        .unwrap();
    let host = m
        .host_function(
            &a,
            &host_id(),
            "persisted",
            1,
            &[a.global_value("captured").unwrap()],
        )
        .unwrap();
    b.define_global_value("host", &host).unwrap();
    eval(&b, "var result = 0; var bound = host.bind(null, 2); var proxy = new Proxy(host, {}); var obj = Object.defineProperty({}, 'value', {get:bound}); Promise.resolve(3).then(host).then(x => result = x); 0");
    drop(host);
    drop(a);
    m.collect().unwrap();
    let ids = m
        .with_persistence(|i| {
            i.shared_environment_ids()
                .into_iter()
                .map(EnvironmentId)
                .collect()
        })
        .unwrap();
    (m, b, ids)
}
#[test]
fn host_recipes_restore_before_bound_accessors_and_queued_calls() {
    let (m, b, ids) = host_fixture();
    let bid = b.snapshot_id().unwrap();
    let signature = Signature::new("host-container");
    let bytes = m
        .with_persistence(|i| i.write_snapshot(&signature))
        .unwrap()
        .unwrap();
    let restored = ironhorse_snapshot::machine::shared_from_snapshot_bytes(
        &bytes,
        &signature,
        host_policy(&ids),
    )
    .unwrap();
    let rb = restored.claim_compartment(bid).unwrap();
    let before = m.run_promise_jobs();
    let after = restored.run_promise_jobs();
    assert!(
        before.completed && after.completed,
        "{:?} {:?}",
        before.halt,
        after.halt
    );
    assert_eq!(
        (before.meter_raw, before.meter_raw_this_run),
        (after.meter_raw, after.meter_raw_this_run)
    );
    for c in [&b, &rb] {
        assert_eq!(
            eval(
                c,
                "result + ':' + bound() + ':' + proxy(4) + ':' + obj.value"
            ),
            "43:42:44:42"
        );
    }
    restored.collect().unwrap();
    assert_eq!(eval(&rb, "host(5)"), "45");
    assert!(restored
        .with_persistence(|i| i.write_snapshot(&signature))
        .unwrap()
        .is_ok());
}
#[test]
fn host_service_reattachment_requires_exact_abi() {
    let (m, _, ids) = host_fixture();
    let signature = Signature::new("host-required");
    let bytes = m
        .with_persistence(|i| i.write_snapshot(&signature))
        .unwrap()
        .unwrap();
    for wrong_abi in [false, true] {
        let mut policy = empty_policy(&ids);
        if wrong_abi {
            let mut id = host_id();
            id.abi += 1;
            policy
                .host_callables
                .insert(id, std::rc::Rc::new(PersistedHost));
        }
        let interp = from_snapshot_bytes(&bytes, &signature).unwrap();
        assert!(matches!(
            Machine::from_restored_interpreter(interp, policy),
            Err(ironhorse_vm::Halt::Refused("host:missing-restored-service"))
        ));
    }
}
#[test]
fn host_captures_survive_eager_lazy_store_collection_checkpoint_and_rewind() {
    use ironhorse_snapshot::machine::{
        begin_shared_store_session, resume_shared_from_store, resume_shared_from_store_lazy,
    };
    use ironhorse_snapshot::store::MemoryStore;
    use std::{cell::RefCell, rc::Rc};
    for lazy in [false, true] {
        let (m, b, ids) = host_fixture();
        let bid = b.snapshot_id().unwrap();
        let signature = Signature::new("host-store");
        let store = Rc::new(RefCell::new(MemoryStore::new()));
        let mut live = begin_shared_store_session(m, &signature, &mut *store.borrow_mut(), 0)
            .ok()
            .unwrap();
        live.checkpoint(&signature, &mut *store.borrow_mut())
            .unwrap();
        let mut restored = if lazy {
            resume_shared_from_store_lazy(store.clone(), &signature, host_policy(&ids)).unwrap()
        } else {
            resume_shared_from_store(&*store.borrow(), &signature, host_policy(&ids)).unwrap()
        };
        let rb = restored.machine().claim_compartment(bid).unwrap();
        let expected = live.machine().run_promise_jobs();
        let actual = restored.machine().run_promise_jobs();
        assert_eq!(expected.meter_raw, actual.meter_raw);
        assert!(actual.completed);
        assert_eq!(eval(&rb, "result + ':' + obj.value"), "43:42");
        restored
            .checkpoint(&signature, &mut *store.borrow_mut())
            .unwrap();
        restored.full_collect(&*store.borrow()).unwrap();
        restored
            .checkpoint(&signature, &mut *store.borrow_mut())
            .unwrap();
        let root = rb.global_value("host").unwrap();
        eval(&rb, "result = 90; 0");
        let rewound =
            resume_shared_from_store(&*store.borrow(), &signature, host_policy(&ids)).unwrap();
        let mut wb = rewound.machine().claim_compartment(bid).unwrap();
        assert!(wb.define_global_value("old", &root).is_err());
        assert_eq!(eval(&wb, "result + ':' + host(9)"), "43:49");
    }
}
#[test]
fn malformed_host_recipes_and_old_format_fail_before_execution() {
    let (m, _, _) = host_fixture();
    let signature = Signature::new("host-malformed");
    let image = m
        .with_persistence(|i| i.snapshot_image(&signature))
        .unwrap()
        .unwrap()
        .into_image();
    for case in 0..9 {
        let mut bad = image.clone();
        let shared = bad.function_state.shared.as_mut().unwrap();
        match case {
            0 => shared.host_functions[0].owner = shared.default_global,
            1 => shared.host_functions[0].name_chunk = u32::MAX,
            2 => {
                shared.host_functions[0].captures[0] = ironhorse_vm::Slot::of(
                    ironhorse_vm::Kind::Reference,
                    ironhorse_vm::Payload::Reference(ironhorse_vm::SlotIndex(u32::MAX)),
                )
            }
            3 => shared.host_functions[0].name = "different".into(),
            4 => {
                let owner = shared.host_functions[0].owner;
                shared.function_environments.retain(|(f, _)| *f != owner);
            }
            5 => bad.version.format_version = 21,
            6 => shared.host_functions[0].name_chunk += 1,
            7 => {
                let old = shared.host_functions[0].owner;
                let proxy = bad.proxy_state.proxies[0].owner;
                shared.host_functions[0].owner = proxy;
                for (owner, _) in &mut shared.function_environments {
                    if *owner == old {
                        *owner = proxy;
                    }
                }
                shared.function_environments.sort_unstable();
            }
            8 => shared.host_functions[0].arity = u32::MAX,
            _ => unreachable!(),
        }
        let bytes = ironhorse_snapshot::image::write_machine_unchecked(&bad);
        if case == 5 {
            assert!(matches!(
                from_snapshot_bytes(&bytes, &signature),
                Err(ironhorse_snapshot::SnapshotError::Corrupt(
                    "host functions require format 22"
                ))
            ));
        } else {
            assert!(
                from_snapshot_bytes(&bytes, &signature).is_err(),
                "accepted case {case}"
            );
        }
    }
}

struct CaptureValue;
impl ironhorse_vm::HostCallable for CaptureValue {
    fn call<'s>(&self, cx: &mut ironhorse_vm::HostCallContext<'s>) -> ironhorse_vm::HostResult<'s> {
        Ok(cx
            .capture(cx.argument(0).as_integer().unwrap() as usize)
            .unwrap())
    }
}
#[test]
fn primitive_host_captures_are_relocated_by_collection_and_store_restore() {
    use ironhorse_snapshot::{
        machine::{begin_shared_store_session, resume_shared_from_store_lazy},
        store::MemoryStore,
    };
    use std::{cell::RefCell, rc::Rc};
    let m = Machine::new();
    let a = m.new_compartment();
    let mut b = m.new_compartment();
    eval(
        &a,
        r"var garbage='x'.repeat(10000); var text='\ud800kept'; var big=123456789012345678901234567890n; var sym=Symbol('onlyCapture'); garbage=undefined; 0",
    );
    let id = ironhorse_vm::HostCallableId {
        name: "captures".into(),
        abi: 1,
    };
    m.register_host_callable(id.clone(), Rc::new(CaptureValue))
        .unwrap();
    let captures = [
        a.global_value("text").unwrap(),
        a.global_value("big").unwrap(),
        a.global_value("sym").unwrap(),
    ];
    let h = m.host_function(&a, &id, "capture", 1, &captures).unwrap();
    b.define_global_value("capture", &h).unwrap();
    eval(&b, "0");
    eval(&a, "text=big=sym=undefined; 0");
    drop(captures);
    drop(h);
    drop(a);
    let bid = b.snapshot_id().unwrap();
    let ids = m
        .with_persistence(|i| {
            i.shared_environment_ids()
                .into_iter()
                .map(EnvironmentId)
                .collect::<Vec<_>>()
        })
        .unwrap();
    m.collect().unwrap();
    let signature = Signature::new("primitive-host-captures");
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    let mut session = begin_shared_store_session(m, &signature, &mut *store.borrow_mut(), 0)
        .ok()
        .unwrap();
    session
        .checkpoint(&signature, &mut *store.borrow_mut())
        .unwrap();
    session.full_collect(&*store.borrow()).unwrap();
    session
        .checkpoint(&signature, &mut *store.borrow_mut())
        .unwrap();
    let mut policy = empty_policy(&ids);
    policy.host_callables.insert(id, Rc::new(CaptureValue));
    let restored = resume_shared_from_store_lazy(store, &signature, policy).unwrap();
    let rb = restored.machine().claim_compartment(bid).unwrap();
    for c in [&b, &rb] {
        assert_eq!(
            eval(
                c,
                r"capture(0)==='\ud800kept' && capture(1)===123456789012345678901234567890n && capture(2).description==='onlyCapture' && capture(2)===capture(2)"
            ),
            "true"
        );
    }
}

#[test]
fn host_functions_created_after_collection_remain_persistable() {
    let m = Machine::new();
    let mut c = m.new_compartment();
    eval(&c, "var value=42; 0");
    m.collect().unwrap();
    m.register_host_callable(host_id(), std::rc::Rc::new(CaptureValue))
        .unwrap();
    let h = m
        .host_function(
            &c,
            &host_id(),
            "afterGC",
            1,
            &[c.global_value("value").unwrap()],
        )
        .unwrap();
    c.define_global_value("host", &h).unwrap();
    assert_eq!(eval(&c, "host(0)"), "42");
    let signature = Signature::new("host-after-gc");
    let bytes = m
        .with_persistence(|i| i.write_snapshot(&signature))
        .unwrap()
        .unwrap();
    assert!(from_snapshot_bytes(&bytes, &signature).is_ok());
}
