//! Realm identity, persistent globals, and shared frozen intrinsic objects.
use ironhorse_vm::{Compartment, CompartmentOptions, Halt, Machine, Slot};

fn evaluate(compartment: &Compartment, source: &str) -> ironhorse_vm::RunOutcome {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    compartment.evaluate_with_symbols(&code, &symbols)
}

fn eval(compartment: &Compartment, source: &str) -> String {
    let out = evaluate(compartment, source);
    assert!(out.completed, "{source}: {:?}", out.halt);
    out.result
}

#[test]
fn primordial_identity_is_shared_and_globals_persist_independently() {
    let machine = Machine::new();
    let a = machine.new_compartment();
    let b = machine.new_compartment();
    assert_eq!(eval(&a, "var saved = Object.prototype; var n = 3; n"), "3");
    let object_proto = a.global_object_identity("saved").unwrap();
    assert_eq!(
        eval(&b, "var saved = Object.prototype; var n = 70; n"),
        "70"
    );
    assert_eq!(
        b.global_object_identity("saved"),
        Some(object_proto.clone())
    );
    assert_eq!(eval(&a, "n += 1; saved === Object.prototype"), "true");
    assert_eq!(
        a.global_object_identity("saved"),
        Some(object_proto.clone())
    );
    assert_eq!(eval(&b, "n"), "70");
    assert_eq!(eval(&a, "n"), "4");
    eval(&a, "var ownGlobal = globalThis; ownGlobal");
    eval(&b, "var ownGlobal = globalThis; ownGlobal");
    assert_ne!(
        a.global_object_identity("ownGlobal"),
        b.global_object_identity("ownGlobal")
    );
}

#[test]
fn frozen_intrinsics_reject_mutation_across_later_symbols_and_realms() {
    let machine = Machine::new();
    let a = machine.new_compartment();
    let b = machine.new_compartment();
    assert_eq!(eval(&a, "Object.isFrozen(Object.prototype) && Object.isFrozen(Array.prototype) && Object.isFrozen(Object)"), "true");
    assert_eq!(
        eval(
            &a,
            "Object.prototype.leak = 7; typeof Object.prototype.leak"
        ),
        "undefined"
    );
    assert_eq!(eval(&b, "typeof Object.prototype.leak"), "undefined");
    assert_eq!(eval(&a, "try { Object.defineProperty(Array.prototype, 'map', {value: 3}); } catch(e) { e.name; }"), "TypeError");
    assert_eq!(eval(&b, "[1,2].map(x => x + 1).join(',')"), "2,3");
}

#[test]
fn named_endowments_bind_once_and_explicit_updates_rebind() {
    let machine = Machine::new();
    let mut a = machine.new_compartment();
    let b = machine.new_compartment();
    a.define_global("answer", Slot::integer(40));
    assert_eq!(eval(&a, "answer += 1; answer"), "41");
    assert_eq!(eval(&b, "typeof answer"), "undefined");
    assert_eq!(eval(&a, "answer += 1; answer"), "42");
    a.define_global("answer", Slot::integer(40));
    assert_eq!(eval(&a, "answer"), "40");
}

#[test]
fn endowment_rebinding_preserves_one_property_and_deletion() {
    let machine = Machine::new();
    let mut a = machine.new_compartment();
    a.define_global("answer", Slot::integer(1));
    assert_eq!(eval(&a, "answer"), "1");
    a.define_global("answer", Slot::integer(2));
    assert_eq!(eval(&a, "answer"), "2");
    assert_eq!(
        eval(
            &a,
            "Object.keys(globalThis).filter(k => k === 'answer').length"
        ),
        "1"
    );
    assert_eq!(
        eval(&a, "delete globalThis.answer; typeof answer"),
        "undefined"
    );
    a.define_global("answer", Slot::integer(3));
    assert_eq!(eval(&a, "answer"), "3");
}

#[test]
fn endowment_rebinding_respects_global_descriptors_and_integrity() {
    for restriction in [
        "Object.freeze(globalThis)",
        "Object.defineProperty(globalThis, 'answer', {writable: false, configurable: false})",
    ] {
        let machine = Machine::new();
        let mut a = machine.new_compartment();
        a.define_global("answer", Slot::integer(1));
        eval(&a, restriction);
        a.define_global("answer", Slot::integer(2));
        assert!(matches!(
            evaluate(&a, "answer").halt,
            Halt::Refused("compartment:global-definition-rejected")
        ));
        a.define_global("answer", Slot::integer(1));
        assert_eq!(eval(&a, "answer"), "1");
    }
    let machine = Machine::new();
    let mut a = machine.new_compartment();
    eval(&a, "Object.preventExtensions(globalThis)");
    a.define_global("missing", Slot::integer(1));
    assert!(matches!(
        evaluate(&a, "1").halt,
        Halt::Refused("compartment:global-definition-rejected")
    ));
}

#[test]
fn caught_native_callback_panics_do_not_strand_siblings() {
    for source in [
        "[1,2,3].map(x => x + 1).join(',')",
        "[1,2,3].forEach(x => { for (var i=0; i<10; i++) {} }); 1",
        "Promise.resolve().then(() => [1,2,3].map(x => x + 1)); 1",
    ] {
        let machine = Machine::new();
        let sibling = machine.new_compartment();
        let a = machine.new_compartment();
        let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            a.evaluate_with_symbols_metered(
                &code,
                &symbols,
                1,
                Box::new(|_| panic!("host panic probe")),
            )
        }));
        let panicked = if result.is_err() {
            true
        } else {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                machine.resume_promise_jobs(Box::new(|_| panic!("host job panic probe")))
            }))
            .is_err()
        };
        assert!(panicked, "{source}");
        drop(a);
        assert_eq!(eval(&sibling, "42"), "42");
        machine.collect().unwrap();
    }
}

#[test]
fn realm_permit_applies_at_creation_and_later_relinking() {
    let machine = Machine::new();
    let empty = machine.compartment(CompartmentOptions {
        intrinsic_permit: Some(vec![]),
        ..Default::default()
    });
    let selective = machine.compartment(CompartmentOptions {
        intrinsic_permit: Some(vec!["Object".into()]),
        ..Default::default()
    });
    assert_eq!(
        eval(&empty, "typeof eval + ':' + typeof $262"),
        "undefined:undefined"
    );
    assert_eq!(
        eval(&empty, "typeof Function + ':' + typeof Object"),
        "undefined:undefined"
    );
    assert_eq!(
        eval(&selective, "typeof Object + ':' + typeof eval"),
        "function:undefined"
    );
    assert_eq!(eval(&empty, "typeof globalThis"), "object");
}

#[test]
fn failed_compartment_jobs_keep_their_context_when_a_sibling_pumps() {
    let machine = Machine::new();
    let a = machine.new_compartment();
    let b = machine.new_compartment();
    let out = evaluate(
        &a,
        "var n = 1; Promise.resolve().then(() => n = 9); throw 1",
    );
    assert!(!out.completed);
    assert_eq!(eval(&b, "1"), "1");
    assert_eq!(eval(&a, "n"), "1");
    assert!(machine.run_promise_jobs().completed);
    assert_eq!(eval(&a, "n"), "9");
    assert_eq!(eval(&b, "typeof n"), "undefined");
}

#[test]
fn closures_keep_their_globals_across_sibling_execution() {
    let machine = Machine::new();
    let a = machine.new_compartment();
    let b = machine.new_compartment();
    eval(&a, "var n = 10; var f = () => ++n; f");
    eval(&b, "var n = 70; n");
    assert_eq!(eval(&a, "f()"), "11");
    assert_eq!(eval(&b, "n"), "70");
}

#[test]
fn collection_preserves_inactive_globals_closures_and_rooted_identities() {
    let machine = Machine::new();
    let a = machine.new_compartment();
    let b = machine.new_compartment();
    eval(
        &a,
        "var value = {text: 'alpha'}; var saved = value; var f = () => saved.text; value",
    );
    let identity = a.global_object_identity("value").unwrap();
    eval(&b, "var value = {text: 'beta'}; value");
    machine.collect().unwrap();
    assert_eq!(a.global_object_identity("value"), Some(identity.clone()));
    assert_eq!(eval(&a, "f()"), "alpha");
    assert_eq!(eval(&b, "value.text"), "beta");
    eval(&a, "value = null; 0");
    machine.collect().unwrap();
    assert_eq!(a.global_object_identity("saved"), Some(identity));
}

#[test]
fn dropping_a_failed_compartment_retains_jobs_in_their_environment() {
    let machine = Machine::new();
    let b = machine.new_compartment();
    {
        let a = machine.new_compartment();
        let out = evaluate(
            &a,
            "Promise.resolve().then(() => { globalThis.orphanLeak = 1; }); throw 1",
        );
        assert!(!out.completed);
    }
    assert_eq!(eval(&b, "40+2"), "42");
    assert_eq!(eval(&b, "typeof orphanLeak"), "undefined");
    machine.collect().unwrap();
}

#[test]
fn object_identities_do_not_alias_between_machines() {
    let m1 = Machine::new();
    let m2 = Machine::new();
    let a = m1.new_compartment();
    let b = m2.new_compartment();
    eval(&a, "var saved = Object.prototype; saved");
    eval(&b, "var saved = Object.prototype; saved");
    assert_ne!(
        a.global_object_identity("saved"),
        b.global_object_identity("saved")
    );
}

#[test]
fn frozen_primordials_do_not_expose_mutable_date_or_collection_state() {
    let machine = Machine::new();
    let a = machine.new_compartment();
    let b = machine.new_compartment();
    for source in [
        "try { Date.prototype.setTime(123); } catch (e) { e.name; }",
        "try { Map.prototype.set('leak', 123); } catch (e) { e.name; }",
        "try { Set.prototype.add(123); } catch (e) { e.name; }",
    ] {
        assert_eq!(eval(&a, source), "TypeError", "{source}");
        assert_eq!(eval(&b, source), "TypeError", "{source}");
    }
}

#[test]
fn metering_hosts_are_released_after_execution_refusal_and_panic() {
    use std::rc::Rc;
    let machine = Machine::new();
    let a = machine.new_compartment();
    let (code, symbols) = ironhorse_compile::compile_atoms("var i=0; while(i<10) i++; i").unwrap();
    for mode in 0..3 {
        let captured = Rc::new(());
        let weak = Rc::downgrade(&captured);
        let sibling = machine.new_compartment();
        let host = Box::new(move |_| {
            // Both this lease and the sibling must leave the interpreter after
            // this operation. Retaining the sibling would form an Rc cycle.
            let _keep = (&captured, sibling.global_this());
            assert!(mode != 2, "host panic probe");
            mode == 0
        });
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            a.evaluate_with_symbols_metered(&code, &symbols, 1, host)
        }));
        assert!(weak.upgrade().is_none(), "host retained after mode {mode}");
        if mode == 2 {
            assert!(result.is_err());
        } else {
            assert_eq!(result.unwrap().completed, mode == 0);
        }
        assert_eq!(eval(&a, "1"), "1");
    }
}

#[test]
fn non_global_primordial_families_are_frozen_across_realms() {
    let machine = Machine::new();
    let a = machine.new_compartment();
    let b = machine.new_compartment();
    for expression in [
        "Object.getPrototypeOf(function*(){})",
        "Object.getPrototypeOf(async function(){})",
        "Object.getPrototypeOf(async function*(){})",
        "Object.getPrototypeOf([][Symbol.iterator]())",
        "Object.getPrototypeOf(new Map()[Symbol.iterator]())",
        "Object.getPrototypeOf(new Set()[Symbol.iterator]())",
        "Object.getPrototypeOf(''[Symbol.iterator]())",
    ] {
        assert_eq!(eval(&a, &format!("Object.isFrozen({expression})")), "true");
        assert_eq!(
            eval(
                &a,
                &format!(
                    "({expression}).environmentLeak = 123; typeof ({expression}).environmentLeak"
                )
            ),
            "undefined"
        );
        assert_eq!(
            eval(&b, &format!("typeof ({expression}).environmentLeak")),
            "undefined"
        );
    }
}

#[test]
fn compiled_programs_have_distinct_tagged_template_sites() {
    let machine = Machine::new();
    let a = machine.new_compartment();
    let b = machine.new_compartment();
    for (compartment, word) in [(&a, "alpha"), (&a, "beta"), (&b, "gamma")] {
        let (code, symbols) = ironhorse_compile::compile_atoms(&format!(
            "function tag(t){{return t[0]}}; tag`{word}`"
        ))
        .unwrap();
        let out = compartment.evaluate_with_symbols(&code, &symbols);
        assert!(out.completed, "{:?}", out.halt);
        assert_eq!(out.result, word);
    }
}

#[test]
fn compilers_capturing_siblings_are_released_after_execution() {
    use std::rc::Rc;
    struct Compiler {
        _sibling: Compartment,
        _lease: Rc<()>,
    }
    impl ironhorse_vm::SourceCompiler for Compiler {
        fn compile_source(
            &self,
            _: &str,
            _: bool,
            _: u64,
            _: &mut dyn FnMut(u64) -> bool,
        ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
            unreachable!("test does not invoke dynamic compilation")
        }
    }
    for malformed in [false, true] {
        let lease = Rc::new(());
        let weak = Rc::downgrade(&lease);
        let machine = Machine::new();
        let mut a = machine.new_compartment();
        a.set_source_compiler(Rc::new(Compiler {
            _sibling: machine.new_compartment(),
            _lease: lease,
        }));
        if malformed {
            assert!(!a.evaluate(&[255]).completed);
        } else {
            assert_eq!(eval(&a, "1"), "1");
        }
        drop(a);
        drop(machine);
        assert!(weak.upgrade().is_none());
    }
}

#[test]
fn one_realm_has_a_default_start_environment_and_distinct_compartments() {
    use std::rc::Rc;
    let machine = Machine::new();
    let start = machine.start_compartment();
    let a = machine.new_compartment();
    eval(&start, "var answer = 17; answer");
    eval(&a, "var answer = 99; answer");
    assert!(Rc::ptr_eq(start.realm(), a.realm()));
    assert_eq!(
        start.environment().unwrap().global_object(),
        machine.realm().global_object()
    );
    assert_eq!(eval(&machine.start_compartment(), "answer"), "17");
    assert_ne!(
        a.environment().unwrap().global_object(),
        machine.realm().global_object()
    );
}

#[test]
fn shared_values_preserve_identity_mutation_and_foreign_global_indexes() {
    let machine = Machine::new();
    let a = machine.new_compartment();
    let mut b = machine.new_compartment();
    eval(&a, "var value = {n: 1}; var ownGlobal = globalThis; value");
    b.define_global_value("value", &a.global_value("value").unwrap())
        .unwrap();
    b.define_global_value("otherGlobal", &a.global_value("ownGlobal").unwrap())
        .unwrap();
    assert_eq!(
        eval(&b, "value.n = 42; otherGlobal.added = 7; value"),
        "[object Object]"
    );
    assert_eq!(
        a.global_object_identity("value"),
        b.global_object_identity("value")
    );
    assert_eq!(eval(&a, "value.n + added"), "49");
    eval(&b, "delete otherGlobal.added; 0");
    assert_eq!(eval(&a, "typeof added"), "undefined");
    machine.collect().unwrap();
    assert_eq!(eval(&b, "value.n"), "42");
    let other = Machine::new();
    assert!(other
        .new_compartment()
        .define_global_value("value", &a.global_value("value").unwrap())
        .is_err());
}

#[test]
fn nested_cross_compartment_calls_restore_defining_globals() {
    let machine = Machine::new();
    let mut a = machine.new_compartment();
    let mut b = machine.new_compartment();
    eval(
        &a,
        "var answer = 42; var read = () => answer; var callB = () => fromB() + ':' + answer; 0",
    );
    b.define_global_value("fromA", &a.global_value("read").unwrap())
        .unwrap();
    eval(
        &b,
        "var answer = 99; var read = () => fromA() + ':' + answer; 0",
    );
    a.define_global_value("fromB", &b.global_value("read").unwrap())
        .unwrap();
    assert_eq!(eval(&a, "callB()"), "42:99:42");
    assert_eq!(
        eval(&b, "[1,2].map(fromA).join(',') + ':' + answer"),
        "42,42:99"
    );
    eval(&a, "var throws = () => { throw answer }; 0");
    b.define_global_value("throwsA", &a.global_value("throws").unwrap())
        .unwrap();
    assert_eq!(
        eval(&b, "try { throwsA() } catch(e) { e + ':' + answer }"),
        "42:99"
    );
    machine.collect().unwrap();
    assert_eq!(eval(&a, "callB()"), "42:99:42");
}

#[test]
fn functions_and_chunk_values_survive_origin_drop_and_collection() {
    let machine = Machine::new();
    let mut b = machine.new_compartment();
    {
        let a = machine.new_compartment();
        eval(
            &a,
            "var answer = 42; var read = () => answer; var text = 'rooted text'; 0",
        );
        b.define_global_value("read", &a.global_value("read").unwrap())
            .unwrap();
        b.define_global_value("text", &a.global_value("text").unwrap())
            .unwrap();
    }
    machine.collect().unwrap();
    assert_eq!(eval(&b, "read() + ':' + text"), "42:rooted text");
    machine.collect().unwrap();
    assert_eq!(eval(&b, "read()"), "42");
}

#[test]
fn promise_settlement_from_another_compartment_preserves_order_and_context() {
    let machine = Machine::new();
    let mut b = machine.new_compartment();
    {
        let a = machine.new_compartment();
        eval(&a, "var answer = 'A'; var events = []; var resolve; var p = new Promise(r => resolve = r); p.then(() => events.push(answer)); var read = () => events.join(','); 0");
        b.define_global_value("resolve", &a.global_value("resolve").unwrap())
            .unwrap();
        b.define_global_value("p", &a.global_value("p").unwrap())
            .unwrap();
        b.define_global_value("events", &a.global_value("events").unwrap())
            .unwrap();
        b.define_global_value("read", &a.global_value("read").unwrap())
            .unwrap();
    }
    machine.collect().unwrap();
    eval(
        &b,
        "var answer = 'B'; p.then(() => events.push(answer)); resolve(); 0",
    );
    assert_eq!(eval(&b, "read()"), "");
    assert!(machine.run_promise_jobs().completed);
    assert_eq!(eval(&b, "read()"), "A,B");
}

#[test]
fn queued_callbacks_survive_collection_and_origin_drop_until_explicit_pump() {
    let machine = Machine::new();
    let mut b = machine.new_compartment();
    {
        let a = machine.new_compartment();
        let outcome = evaluate(&a, "var answer = 42; var state = {n:0}; Promise.resolve().then(() => state.n = answer); throw 1");
        assert!(!outcome.completed);
        b.define_global_value("state", &a.global_value("state").unwrap())
            .unwrap();
    }
    machine.collect().unwrap();
    assert!(machine.run_promise_jobs().completed);
    assert_eq!(eval(&b, "state.n"), "42");
}

#[test]
fn rejection_reports_are_associated_with_the_promise_environment() {
    let machine = Machine::new();
    let a = machine.new_compartment();
    let mut b = machine.new_compartment();
    eval(
        &a,
        "var reject; var p = new Promise((_, r) => reject = r); 0",
    );
    b.define_global_value("rejectA", &a.global_value("reject").unwrap())
        .unwrap();
    assert!(evaluate(&b, "rejectA(42); 0").unhandled_rejection.is_none());
    assert!(machine.run_promise_jobs().completed);
    assert!(evaluate(&a, "0").unhandled_rejection.is_some());
    machine.collect().unwrap();
    assert!(evaluate(&b, "0").unhandled_rejection.is_none());
}

#[test]
fn start_compartment_children_use_the_machine_counter() {
    let machine = Machine::new();
    let start = machine.start_compartment();
    let first = start.new_compartment();
    let second = machine.new_compartment();
    let third = machine.start_compartment().new_compartment();
    assert_eq!(
        start.global_this(),
        machine.start_compartment().global_this()
    );
    assert_ne!(first.global_this(), second.global_this());
    assert_ne!(first.global_this(), third.global_this());
    assert_ne!(second.global_this(), third.global_this());
}

#[test]
fn metered_machine_pump_resumes_the_existing_receipt_and_detaches_host() {
    use std::rc::Rc;
    let machine = Machine::new();
    let a = machine.new_compartment();
    let (code, symbols) = ironhorse_compile::compile_atoms(
        "var n = 0; Promise.resolve().then(() => n = 42); throw 1",
    )
    .unwrap();
    let before = a.evaluate_with_symbols_metered(&code, &symbols, 1, Box::new(|_| true));
    assert!(!before.completed);
    assert_eq!(machine.run_promise_jobs().halt, Halt::MeterAbort);
    let lease = Rc::new(());
    let weak = Rc::downgrade(&lease);
    let resumed = machine.resume_promise_jobs(Box::new(move |_| {
        let _ = &lease;
        true
    }));
    assert!(resumed.completed, "{:?}", resumed.halt);
    assert!(resumed.meter_raw >= before.meter_raw);
    assert!(resumed.meter_raw_this_run > 0);
    assert!(weak.upgrade().is_none());
    assert_eq!(eval(&a, "n"), "42");
}

#[test]
fn machine_reports_rejections_from_collected_orphan_compartments() {
    let machine = Machine::new();
    let a = machine.new_compartment();
    let out = evaluate(
        &a,
        "Promise.resolve().then(() => { throw 'orphan rejection'; }); throw 1",
    );
    assert!(!out.completed);
    drop(a);
    machine.collect().unwrap();
    assert!(machine.run_promise_jobs().completed);
    machine.collect().unwrap();
    let reports = machine.unhandled_rejections().unwrap();
    assert_eq!(reports.len(), 1);
    let mut inspector = machine.new_compartment();
    inspector
        .define_global_value("reason", &reports[0].reason)
        .unwrap();
    machine.collect().unwrap();
    assert_eq!(eval(&inspector, "reason"), "orphan rejection");
    assert_eq!(
        machine.take_unhandled_rejections().unwrap()[0].promise,
        reports[0].promise
    );
    assert!(machine.unhandled_rejections().unwrap().is_empty());
}
