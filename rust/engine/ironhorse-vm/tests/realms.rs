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
fn failed_realm_cannot_run_its_pending_jobs_in_a_sibling() {
    let machine = Machine::new();
    let a = machine.new_compartment();
    let b = machine.new_compartment();
    let out = evaluate(
        &a,
        "var n = 1; Promise.resolve().then(() => n = 9); throw 1",
    );
    assert!(!out.completed);
    assert!(matches!(evaluate(&b, "1").halt, Halt::RealmBusy));
    assert_eq!(eval(&a, "n"), "1");
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
fn dropping_a_failed_realm_discards_its_jobs_without_blocking_siblings() {
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
                &format!("({expression}).realmLeak = 123; typeof ({expression}).realmLeak")
            ),
            "undefined"
        );
        assert_eq!(
            eval(&b, &format!("typeof ({expression}).realmLeak")),
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
