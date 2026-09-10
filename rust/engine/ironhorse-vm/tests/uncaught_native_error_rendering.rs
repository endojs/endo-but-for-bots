use ironhorse_vm::{parse_symbols, Halt, Interp, Kind, RunOutcome};

fn run(source: &str) -> (Interp, RunOutcome) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut interp = Interp::new();
    interp.link_intrinsics(&parse_symbols(&symbols));
    let outcome = interp.run(&code);
    (interp, outcome)
}

#[test]
fn diagnostic_getter_is_not_invoked_and_preserves_original_value() {
    let (mut interp,out)=run("try {(0)()}catch(e){Object.defineProperty(e,'message',{get(){throw 'diagnostic failure'}});throw e}");
    assert!(!out.completed);
    assert!(!interp.is_quiescent());
    match out.halt {
        Halt::Throw { value, rendered } => {
            assert_eq!(
                value.kind,
                Kind::Reference,
                "original native error survives"
            );
            assert_eq!(rendered, "TypeError: <accessor>");
        }
        other => panic!("original throw changed: {other:?}"),
    }
    let (code, symbols) = ironhorse_compile::compile_atoms("40+2").unwrap();
    let code = interp
        .relink_crank(&code, &parse_symbols(&symbols))
        .unwrap();
    let next = interp.run(&code);
    assert!(next.completed);
    assert_eq!(next.result, "42");
    assert!(interp.is_quiescent());
}

#[test]
fn diagnostic_getter_body_does_not_change_the_guest_run_cost() {
    let source = |count| {
        format!("try {{(0)()}}catch(e){{Object.defineProperty(e,'message',{{get(){{var i=0;while(i<{count})i++;return 'detail'}}}});throw e}}")
    };
    let (_, short) = run(&source(1));
    let (_, long) = run(&source(1000));
    assert_eq!(short.halt.thrown_rendering(), Some("TypeError: <accessor>"));
    assert_eq!(long.halt.thrown_rendering(), short.halt.thrown_rendering());
    assert_eq!(
        long.computrons, short.computrons,
        "host rendering is unmetered"
    );
}

#[test]
fn completions_and_throws_read_live_error_data_properties() {
    for (setup, expected) in [
        ("var e=new Error('a');e.message='b'", "Error: b"),
        ("var e=new TypeError('a');e.name='Renamed'", "Renamed: a"),
        ("var e=new Error('a');delete e.message", "Error"),
        ("var e=new Error('a');e.name=''", "a"),
        ("var e=new Error('a');e.message=undefined;e.name=undefined", "Error"),
        ("var e=new Error('a');e.message=42;e.name=null", "null: 42"),
        ("var e=new Error('a');delete e.message;Error.prototype.message='inherited'", "Error: inherited"),
        ("var e=new Error('a');Object.setPrototypeOf(e,{name:'Parent',message:'base'});delete e.message", "Parent: base"),
        ("var e=new Error('a');Object.setPrototypeOf(e,null);delete e.message", "Error"),
        ("var e=new Error('a');Object.defineProperty(e,'message',{get(){throw 1}})", "Error: <accessor>"),
        ("var e=new Error('a');e.message={toString(){throw 1}}", "Error: <object>"),
        ("var e=new Error('a');delete e.message;Object.setPrototypeOf(e,new Proxy({}, {get(){throw 1}}))", "<proxy>: <proxy>"),
    ] {
        for expression in ["e", "[e]", "[[e]]", "Object(e)"] {
            let (_, out) = run(&format!("{setup};{expression}"));
            assert!(out.completed, "{setup};{expression}: {:?}", out.halt);
            assert_eq!(out.result, expected, "{setup};{expression}");
        }
        let (_, out) = run(&format!("{setup};throw e"));
        assert_eq!(out.halt.thrown_rendering(), Some(expected), "{setup}");
    }
}

#[test]
fn diagnostic_hooks_cannot_mutate_state_or_enqueue_a_later_job() {
    for thrown in [
        "({toString(){effects++;Promise.resolve().then(()=>effects++);return 'bad'}})",
        "({[Symbol.toPrimitive](){effects++;throw 1}})",
        "Object.defineProperty(new Error('a'),'message',{get(){effects++;Promise.resolve().then(()=>effects++);return 'bad'}})",
        "Object.setPrototypeOf(new Error('a'),new Proxy({}, {get(){effects++;return 'bad'}}))",
    ] {
        let (mut vm, out) = run(&format!("var effects=0;throw {thrown}"));
        assert!(matches!(out.halt, Halt::Throw { .. }));
        assert!(!vm.is_quiescent());
        // The first successful crank would drain a job leaked by rendering.
        // Read again afterward to distinguish a queued effect from a direct one.
        for _ in 0..2 {
            let (code, symbols) = ironhorse_compile::compile_atoms("effects").unwrap();
            let code = vm.relink_crank(&code, &parse_symbols(&symbols)).unwrap();
            let out = vm.run(&code);
            assert!(out.completed);
            assert_eq!(out.result, "0", "{thrown}");
            assert!(vm.is_quiescent());
        }
    }
}

#[test]
fn explicit_guest_stringification_remains_observable() {
    let (_, out) = run("var n=0;var e=new Error('a');Object.defineProperty(e,'message',{get(){n++;return 'live'}});String(e)+':'+n");
    assert!(out.completed);
    assert_eq!(out.result, "Error: live:1");
}
